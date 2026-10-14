const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

// Parsed DOM trees preserve the exact structure and metadata of the supplied snippets.
class Element {
    constructor(node = { tag: 'button', attributes: {}, children: [] }) {
        this.tag = node.tag;
        this.attributes = { ...node.attributes };
        this.className = this.attributes.class || '';
        this.children = node.children.map(child => typeof child === 'string' ? child : new Element(child));
        this.children.forEach(child => { if (typeof child !== 'string') child.parent = this; });
        this.dataset = {};
        this.style = {};
        this.rect = { left: 100, top: 200, right: 400, bottom: 400, width: 300, height: 200 };
        this.listeners = {};
        this.classList = { add: value => { if (!this.className.split(' ').includes(value)) this.className += ` ${value}`; } };
    }
    get isConnected() { return this.tag === 'fixture' || Boolean(this.parent?.isConnected); }
    getBoundingClientRect() { return this.rect; }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
    }
    get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    set textContent(value) { this.children = [value]; }
    getAttribute(name) { return name === 'class' ? this.className : this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    appendChild(child) { child.parent = this; this.children.push(child); }
    contains(child) { return child === this || this.children.some(node => typeof node !== 'string' && node.contains(child)); }
    matches(selector) {
        const attribute = selector.match(/\[([^\]]+)\]/)?.[1];
        if (attribute && this.getAttribute(attribute) === null) return false;
        const className = selector.match(/\.([\w-]+)/)?.[1];
        if (className && !this.className.split(/\s+/).includes(className)) return false;
        const tag = selector.match(/^[\w-]+/)?.[0];
        return !tag || tag === this.tag;
    }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
    querySelectorAll(selector) {
        const parts = selector.split(' ');
        const result = [];
        const visit = node => {
            if (node.matches(parts.at(-1))) {
                let ancestor = node.parent;
                let index = parts.length - 2;
                while (ancestor && index >= 0) {
                    if (ancestor.matches(parts[index])) index--;
                    ancestor = ancestor.parent;
                }
                if (index < 0) result.push(node);
            }
            node.children.forEach(child => { if (typeof child !== 'string') visit(child); });
        };
        this.children.forEach(child => { if (typeof child !== 'string') visit(child); });
        return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function setup(fixture, { homePage = false } = {}) {
    const root = new Element(JSON.parse(fs.readFileSync(`${__dirname}/fixtures/${fixture}.json`, 'utf8')));
    const card = root.querySelector('.ytLockupViewModelHost');
    let outerCard = card;
    if (homePage) {
        const content = root.children[0];
        content.remove();
        outerCard = new Element({ tag: 'ytd-rich-item-renderer', attributes: {}, children: [] });
        outerCard.appendChild(content);
        root.appendChild(outerCard);
    }
    const added = [];
    const events = {};
    let queue = [];
    const context = {
        URL,
        window: { location: { href: 'https://www.youtube.com/', pathname: homePage ? '/' : '/watch' }, addEventListener(type, handler) { events[type] = handler; } },
        document: {
            body: root,
            createElement: () => new Element(),
            addEventListener(type, handler) { events[type] = handler; },
            querySelectorAll: selector => root.querySelectorAll(selector),
        },
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(`${__dirname}/../services/video-previews.js`, 'utf8'), context);
    const controls = context.createVideoPreviewControls({
        getQueueItems: () => queue,
        async addVideo(metadata) { added.push(JSON.parse(JSON.stringify(metadata))); queue.push(metadata); },
    });
    return {
        root, card, outerCard, added, controls, events,
        location: context.window.location,
        hover() { events.pointerover({ target: card.querySelector('img') }); },
        focus() { events.focusin({ target: card.querySelector('a.ytLockupMetadataViewModelTitle') }); },
        get button() { return root.querySelector('.yt-queue-preview-add-button'); },
        setQueue(items) { queue = items; controls.refreshButtons(); },
        async click() {
            let prevented = false, stopped = false;
            await this.button.listeners.click({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
            assert.equal(prevented, true);
            assert.equal(stopped, true);
        },
    };
}

for (const [fixture, id, channel] of [
    ['suggested-video', 'rmu0Ns8KGdw', 'Pezle'],
    ['home-playlist', 'rwKYWuVluJc', 'Taskmaster'],
    ['channel-video', 'oax6t6Of2WY', 'Unknown Channel'],
]) {
    test(`${fixture}: hover adds the represented video without navigating or duplicating controls`, async () => {
        const preview = setup(fixture);
        assert.equal(preview.button, null);
        preview.hover();
        preview.hover();
        assert.equal(preview.card.querySelectorAll('.yt-queue-preview-add-button').length, 1);
        assert.equal(preview.button.parent, preview.card);
        assert.equal(preview.button.disabled, false);
        if (fixture === 'home-playlist') assert.match(preview.button.title, /first video/);
        await preview.click();
        assert.equal(preview.added.length, 1);
        assert.equal(preview.added[0].id, id);
        assert.equal(preview.added[0].url, `https://www.youtube.com/watch?v=${id}`);
        if (channel) assert.equal(preview.added[0].channel, channel);
        assert.equal(preview.button.dataset.queued, 'true');
        await preview.click();
        assert.equal(preview.added.length, 1);
        preview.setQueue([]);
        assert.equal(preview.button.disabled, false);
    });
}

test('keyboard focus creates the same control and recycled cards use their latest video link', async () => {
    const preview = setup('channel-video');
    preview.focus();
    assert.ok(preview.button);
    const link = preview.card.querySelector('a.ytLockupViewModelContentImage');
    link.setAttribute('href', '/watch?v=rmu0Ns8KGdw');
    preview.card.querySelector('h3[title]').setAttribute('title', 'Updated title');
    preview.controls.refreshButtons();
    await preview.click();
    assert.equal(preview.added[0].id, 'rmu0Ns8KGdw');
    assert.equal(preview.added[0].title, 'Updated title');
});

test('unsupported links are skipped or hidden when an existing card becomes a non-video preview', () => {
    for (const href of ['/playlist?list=PL123', '/shorts/rmu0Ns8KGdw', '/@Channel', 'https://example.com/watch?v=rmu0Ns8KGdw']) {
        const preview = setup('channel-video');
        preview.card.querySelector('a.ytLockupViewModelContentImage').setAttribute('href', href);
        preview.hover();
        assert.equal(preview.button, null);
    }
    const preview = setup('channel-video');
    preview.hover();
    preview.card.querySelector('a.ytLockupViewModelContentImage').setAttribute('href', '/playlist?list=PL123');
    preview.controls.refreshButtons();
    assert.equal(preview.button.hidden, true);
});


test('home autoplay can replace the thumbnail while the floating queue button remains clickable', async () => {
    const preview = setup('channel-video', { homePage: true });
    preview.hover();
    const button = preview.button;
    assert.equal(button.parent, preview.root);
    assert.equal(button.style.left, '108px');
    assert.equal(button.style.top, '208px');
    // Autoplay removes the image/link; the title still identifies the same video.
    preview.card.querySelector('a.ytLockupViewModelContentImage').remove();
    preview.controls.refreshButtons();
    assert.equal(preview.button, button);
    assert.equal(button.hidden, false);
    // The player can intercept pointer events outside the card's DOM subtree.
    preview.events.pointermove({ target: preview.root, clientX: 140, clientY: 220 });
    assert.equal(button.hidden, false);
    await preview.click();
    assert.equal(preview.added[0].id, 'oax6t6Of2WY');
    assert.equal(button.dataset.queued, 'true');
});

test('home control tracks scrolling and hides when leaving the card, navigating away, or removing it', () => {
    const preview = setup('channel-video', { homePage: true });
    preview.hover();
    preview.events.pointermove({ clientX: 140, clientY: 220 });
    preview.card.querySelector('a.ytLockupViewModelContentImage').rect.top = 180;
    preview.events.scroll();
    assert.equal(preview.button.style.top, '188px');
    preview.events.pointermove({ clientX: 500, clientY: 500 });
    assert.equal(preview.button.hidden, true);
    preview.hover();
    assert.equal(preview.button.hidden, false);
    preview.location.pathname = '/watch';
    preview.controls.refreshButtons();
    assert.equal(preview.button.hidden, true);
    preview.location.pathname = '/';
    preview.hover();
    preview.outerCard.remove();
    preview.controls.refreshButtons();
    assert.equal(preview.button.hidden, true);
});

test('standard preview buttons are restored after YouTube removes the injected node', async () => {
    const preview = setup('suggested-video');
    preview.hover();
    preview.button.remove();
    assert.equal(preview.button, null);
    preview.controls.refreshButtons();
    assert.ok(preview.button);
    await preview.click();
    assert.equal(preview.added[0].id, 'rmu0Ns8KGdw');
});
