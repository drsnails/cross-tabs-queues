const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function createYouTubePage({ page = 'watch' } = {}) {
    class Element {
        constructor() {
            this.children = [];
            this.style = {};
            this.dataset = {};
            this.listeners = {};
            this.classList = { add() {}, remove() {} };
        }
        get firstElementChild() { return this.children[0]; }
        setAttribute(name, value) { this[name] = value; }
        addEventListener(type, listener) { this.listeners[type] = listener; }
        removeEventListener(type) { delete this.listeners[type]; }
        remove() {
            if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
            this.parent = null;
        }
        appendChild(child) {
            if (child.fragment) {
                [...child.children].forEach(item => this.appendChild(item));
                return;
            }
            child.remove();
            child.parent = this;
            this.children.push(child);
        }
        prepend(child) {
            child.remove();
            child.parent = this;
            this.children.unshift(child);
        }
        insertBefore(child) { this.prepend(child); }
        set innerHTML(html) {
            this.html = html;
            this.children = [];
            for (const match of html.matchAll(/id="([^"]+)"/g)) {
                const child = new Element();
                child.id = match[1];
                this.appendChild(child);
            }
        }
        get innerHTML() { return this.html; }
    }
    const body = new Element();
    const actions = new Element();
    const video = new Element();
    body.appendChild(actions);
    body.appendChild(video);
    let secondary = null;
    let mutationHandler;
    let now = 0;
    let messageHandler;
    let storageHandler;
    const events = {};
    const timers = new Map();
    const queueRequests = [];
    const actionsRequested = [];
    let timerId = 0;
    const location = page === 'watch'
        ? { pathname: '/watch', search: '?v=first', href: 'https://www.youtube.com/watch?v=first' }
        : { pathname: '/', search: '', href: 'https://www.youtube.com/' };
    function find(element, id) {
        if (element.id === id) return element;
        for (const child of element.children) {
            const result = find(child, id);
            if (result) return result;
        }
        return null;
    }
    const context = {
        URLSearchParams, location,
        window: { location, addEventListener(type, handler) { events[type] = handler; } },
        document: {
            body, title: 'YouTube', hidden: false, addEventListener(type, handler) { events[type] = handler; },
            getElementById: id => find(body, id),
            createElement: () => new Element(),
            createDocumentFragment() { const fragment = new Element(); fragment.fragment = true; return fragment; },
            querySelector(selector) {
                if (selector === '#secondary' || selector === '#secondary-inner') return secondary;
                if (selector.includes('top-level-buttons-computed')) return actions;
                if (selector === 'video.html5-main-video') return video;
                return null;
            },
            querySelectorAll: () => [],
        },
        chrome: {
            runtime: {
                getManifest: () => ({}),
                getURL: path => `chrome-extension://test/${path}`,
                sendMessage(message, callback) {
                    if (message.type === 'GET_QUEUE') queueRequests.push(callback);
                    else if (message.type === 'SORT_QUEUE') {
                        actionsRequested.push(JSON.parse(JSON.stringify(message)));
                        callback({ success: true, data: { count: 2, missing: 0 } });
                    }
                },
                onMessage: { addListener(handler) { messageHandler = handler; } },
            },
            storage: { onChanged: { addListener(handler) { storageHandler = handler; } } },
        },
        MutationObserver: class { constructor(handler) { mutationHandler = handler; } observe() {} },
        setTimeout(handler, delayMs) { timers.set(++timerId, { handler, delayMs, dueAt: now + delayMs }); return timerId; },
        clearTimeout(id) { timers.delete(id); },
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(`${__dirname}/../services/video-metadata.js`, 'utf8'), context);
    vm.runInContext(fs.readFileSync(`${__dirname}/../services/diagnostics.js`, 'utf8'), context);
    vm.runInContext(fs.readFileSync(`${__dirname}/../services/video-previews.js`, 'utf8'), context);
    vm.runInContext(fs.readFileSync(`${__dirname}/../main.js`, 'utf8'), context);
    return {
        get: id => find(body, id),
        mountSidebar() {
            secondary = new Element();
            const nativePanel = new Element();
            nativePanel.id = 'native-queue';
            secondary.appendChild(nativePanel);
            body.appendChild(secondary);
        },
        mutate() { mutationHandler(); },
        runTimers() { this.advance(100); },
        tick() { this.advance(15000); },
        advance(durationMs) {
            const end = now + durationMs;
            let executions = 0;
            while (true) {
                const next = [...timers.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
                if (!next || next[1].dueAt > end) break;
                assert.ok(++executions < 1000, 'Timer loop did not settle');
                now = next[1].dueAt;
                timers.delete(next[0]);
                next[1].handler();
            }
            now = end;
        },
        setHidden(hidden) {
            context.document.hidden = hidden;
            events.visibilitychange();
        },
        goHome() {
            location.pathname = '/';
            location.search = '';
            location.href = 'https://www.youtube.com/';
            events['yt-navigate-finish']();
        },
        respond(items) { assert.ok(queueRequests.length); queueRequests.shift()({ success: true, data: items }); },
        changeQueue(items) { storageHandler({ yt_queue_list: { newValue: items } }, 'local'); },
        broadcast() { messageHandler({ type: 'QUEUE_UPDATED' }, {}, () => {}); },
        navigate(id) {
            location.pathname = '/watch';
            location.search = `?v=${id}`;
            location.href = `https://www.youtube.com/watch?v=${id}`;
            events['yt-navigate-finish']();
        },
        get pendingTimers() { return timers.size; },
        get timerDelays() { return [...timers.values()].map(timer => timer.delayMs); },
        get pendingRequests() { return queueRequests.length; },
        actionsRequested,
    };
}
const items = ['first', 'next'].map(id => ({ id, title: id, channel: 'Channel', url: `https://www.youtube.com/watch?v=${id}`, thumbnail: `https://img.youtube.com/vi/${id}/mqdefault.jpg` }));

test('cached queue appears when the sidebar arrives despite continuous YouTube mutations', () => {
    const page = createYouTubePage();
    page.respond(items);
    assert.equal(page.get('yt-queue-sidebar'), null);
    page.mountSidebar();
    for (let index = 0; index < 100; index++) page.mutate();
    assert.equal(page.timerDelays.filter(delay => delay === 100).length, 1);
    page.runTimers();
    assert.ok(page.get('yt-queue-sidebar'));
    assert.equal(page.get('yt-queue-list').children.length, 2);
    assert.equal(page.pendingRequests, 0);
});

test('queue rebuilds after YouTube replaces the sidebar and restores a hidden queue', () => {
    const page = createYouTubePage();
    page.mountSidebar();
    page.respond(items);
    const original = page.get('yt-queue-sidebar');
    original.remove();
    page.tick();
    assert.ok(page.get('yt-queue-sidebar'));
    assert.notEqual(page.get('yt-queue-sidebar'), original);
    assert.equal(page.get('yt-queue-list').children.length, 2);
    page.get('yt-queue-sidebar').style.display = 'none';
    page.tick();
    assert.equal(page.get('yt-queue-sidebar').style.display, '');
    page.navigate('next');
    assert.match(page.get('yt-queue-list').children[1].className, /playing/);
});

test('new storage state wins over a stale queue response; playlist broadcasts reload the queue', () => {
    const page = createYouTubePage();
    page.mountSidebar();
    page.changeQueue(items);
    page.respond([]);
    assert.equal(page.get('yt-queue-list').children.length, 2);
    page.broadcast();
    assert.equal(page.pendingRequests, 1);
    page.respond(items.slice(0, 1));
    assert.equal(page.get('yt-queue-list').children.length, 1);
    page.changeQueue([]);
    assert.equal(page.get('yt-queue-sidebar').style.display, 'none');
});

test('minimizing retains videos and stays collapsed through queue updates, navigation, and sidebar recovery', () => {
    const page = createYouTubePage();
    page.mountSidebar();
    page.respond(items);
    page.get('yt-queue-toggle').listeners.click();
    assert.equal(page.get('yt-queue-list').hidden, true);
    assert.equal(page.get('yt-queue-sort-controls').hidden, true);
    assert.equal(page.get('yt-queue-toggle').textContent, '+');
    assert.equal(page.get('yt-queue-toggle')['aria-label'], 'Expand queue');
    assert.equal(page.get('yt-queue-toggle')['aria-expanded'], 'false');
    assert.equal(page.get('yt-queue-list').children.length, 2);
    page.tick();
    page.changeQueue(items.slice(0, 1));
    page.navigate('next');
    assert.equal(page.get('yt-queue-list').hidden, true);
    page.get('yt-queue-sidebar').remove();
    page.tick();
    assert.equal(page.get('yt-queue-list').hidden, true);
    page.get('yt-queue-toggle').listeners.click();
    assert.equal(page.get('yt-queue-list').hidden, false);
    assert.equal(page.get('yt-queue-toggle').textContent, '−');
    assert.equal(page.get('yt-queue-toggle')['aria-label'], 'Minimize queue');
    assert.equal(page.get('yt-queue-toggle')['aria-expanded'], 'true');
    assert.equal(page.get('yt-queue-list').children.length, 1);
});

test('sidebar sorting sends the chosen field/direction and retains choices after sidebar recovery', () => {
    const page = createYouTubePage();
    page.mountSidebar();
    page.respond(items);
    const field = page.get('yt-queue-sort-field');
    const direction = page.get('yt-queue-sort-direction');
    field.value = 'publishedAt';
    field.listeners.change();
    direction.listeners.click();
    assert.equal(direction.textContent, '↑');
    assert.equal(direction['aria-pressed'], 'true');
    page.get('yt-queue-sort').listeners.click();
    assert.deepEqual(page.actionsRequested, [{ type: 'SORT_QUEUE', payload: { field: 'publishedAt', direction: 'asc' } }]);
    page.respond(items);
    page.get('yt-queue-sidebar').remove();
    page.tick();
    assert.equal(page.get('yt-queue-sort-field').value, 'publishedAt');
    assert.equal(page.get('yt-queue-sort-direction').textContent, '↑');
    page.get('yt-queue-sort-direction').listeners.click();
    assert.equal(page.get('yt-queue-sort-direction').textContent, '↓');
    assert.equal(page.get('yt-queue-sort-direction')['aria-pressed'], 'false');
});


test('home pages load queue state for preview controls without inserting the watch sidebar', () => {
    const page = createYouTubePage({ page: 'home' });
    assert.equal(page.pendingRequests, 1);
    page.mountSidebar();
    page.respond(items);
    page.tick();
    assert.equal(page.get('yt-queue-sidebar'), null);
    assert.equal(page.get('yt-queue-btn-container'), null);
});

test('recovery retries are brief and switch to the slow fallback as soon as the queue is ready', () => {
    const page = createYouTubePage();
    page.respond(items);
    assert.deepEqual(page.timerDelays, [250]);
    page.advance(1000);
    assert.equal(page.get('yt-queue-sidebar'), null);
    assert.deepEqual(page.timerDelays, [250]);
    page.mountSidebar();
    page.advance(250);
    assert.equal(page.get('yt-queue-list').children.length, 2);
    assert.deepEqual(page.timerDelays, [15000]);
});

test('an unavailable sidebar cannot cause endless rapid retries', () => {
    const page = createYouTubePage();
    page.respond(items);
    page.advance(5000);
    assert.deepEqual(page.timerDelays, [15000]);
    assert.equal(page.pendingRequests, 0);
    page.advance(15000);
    assert.deepEqual(page.timerDelays, [15000]);
    page.mountSidebar();
    page.mutate();
    page.advance(100);
    assert.ok(page.get('yt-queue-sidebar'));
    assert.deepEqual(page.timerDelays, [15000]);
});

test('the 15-second fallback repairs missed changes without checking every second', () => {
    const page = createYouTubePage();
    page.mountSidebar();
    page.respond(items);
    assert.deepEqual(page.timerDelays, [15000]);
    page.get('yt-queue-sidebar').remove();
    page.advance(14999);
    assert.equal(page.get('yt-queue-sidebar'), null);
    page.advance(1);
    assert.ok(page.get('yt-queue-sidebar'));
    assert.deepEqual(page.timerDelays, [15000]);
});

test('maintenance stops in background tabs and immediately restores the queue on returning', () => {
    const page = createYouTubePage();
    page.mountSidebar();
    page.respond(items);
    page.setHidden(true);
    assert.deepEqual(page.timerDelays, []);
    page.get('yt-queue-sidebar').remove();
    page.advance(60000);
    assert.equal(page.get('yt-queue-sidebar'), null);
    page.setHidden(false);
    assert.ok(page.get('yt-queue-sidebar'));
    assert.deepEqual(page.timerDelays, [15000]);
});

test('home pages, empty queues, and navigation away have no maintenance timer', () => {
    const home = createYouTubePage({ page: 'home' });
    home.respond(items);
    assert.deepEqual(home.timerDelays, []);
    const page = createYouTubePage();
    page.mountSidebar();
    page.respond([]);
    assert.deepEqual(page.timerDelays, []);
    page.changeQueue(items);
    assert.deepEqual(page.timerDelays, [15000]);
    page.changeQueue([]);
    assert.deepEqual(page.timerDelays, []);
    page.changeQueue(items);
    page.goHome();
    assert.deepEqual(page.timerDelays, []);
});
