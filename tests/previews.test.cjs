const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const { Element } = require('./helpers/dom.cjs');

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
    vm.runInContext(fs.readFileSync(`${__dirname}/../services/video-metadata.js`, 'utf8'), context);
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
        if (fixture === 'suggested-video') {
            assert.equal(preview.added[0].views, 5400000);
            assert.equal(preview.added[0].durationSeconds, 1095);
        }
        if (fixture === 'channel-video') {
            assert.equal(preview.added[0].views, 357000);
            assert.equal(preview.added[0].durationSeconds, 632);
            assert.equal(preview.added[0].publishedAtApproximate, true);
        }
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
    assert.equal(preview.added[0].views, 357000);
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
