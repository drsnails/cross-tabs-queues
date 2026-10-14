const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { createBackground } = require('./helpers/background.cjs');

// A minimal DOM lets these tests exercise the popup's actual event handlers.
function createPopup(background) {
    class Element {
        constructor(tag = 'div') {
            this.tag = tag;
            this.children = [];
            this.listeners = {};
            this.dataset = {};
            this.value = '';
            this.classList = { toggle() {} };
        }
        setAttribute(name, value) { this[name] = value; }
        addEventListener(type, callback) { this.listeners[type] = callback; }
        append(...children) { this.children.push(...children); }
        appendChild(child) { this.append(child); }
        replaceChildren(...children) { this.children = children; }
        querySelector() { return this.submitButton ||= new Element('button'); }
        querySelectorAll() { return []; }
        click() { if (!this.disabled) this.listeners.click?.(); }
        submit() { this.listeners.submit?.({ preventDefault() {} }); }
    }
    const html = fs.readFileSync(`${__dirname}/../popup.html`, 'utf8');
    const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => {
        const element = new Element();
        element.id = match[1];
        return [match[1], element];
    }));
    const context = {
        document: { querySelectorAll: () => Object.values(elements), createElement: tag => new Element(tag) },
        chrome: background.chrome,
        confirm: () => true,
    };
    vm.runInNewContext(fs.readFileSync(`${__dirname}/../popup.js`, 'utf8'), context);
    return elements;
}

async function flush() {
    await new Promise(resolve => setImmediate(resolve));
}

test('popup shares a YouTube queue and supports adding, saving, playlist editing, loading, and playback', async () => {
    const background = createBackground([{ id: 'first', title: 'YouTube video', url: 'https://www.youtube.com/watch?v=first' }], {
        tabs: [{ id: 7, url: 'https://www.youtube.com/watch?v=second', title: 'Stream' }],
    });
    const ui = createPopup(background);
    await flush();
    assert.equal(ui['queue-count'].textContent, '1 item');
    ui['add-current'].click();
    await flush();
    assert.equal(ui['queue-count'].textContent, '2 items');
    assert.equal(background.queue[1].source, 'youtube');
    ui['playlist-name'].value = 'Saved playlist';
    ui['save-form'].submit();
    await flush();
    assert.equal(background.playlists[0].name, 'Saved playlist');
    assert.equal(ui['playlist-items'].children.length, 2);
    ui['rename-name'].value = 'Renamed';
    ui['rename-form'].submit();
    await flush();
    assert.equal(background.playlists[0].name, 'Renamed');
    // Remove the second video from the saved copy; the live queue stays intact.
    ui['playlist-items'].children[1].children[2].children[2].click();
    await flush();
    assert.equal(background.playlists[0].items.length, 1);
    assert.equal(background.queue.length, 2);
    ui['load-playlist'].click();
    await flush();
    assert.equal(ui['queue-count'].textContent, '1 item');
    ui['add-current-to-playlist'].click();
    await flush();
    assert.equal(background.playlists[0].items.length, 2);
    assert.equal(background.queue.length, 1);
    // Click the queue title to navigate the active tab.
    ui['queue-items'].children[0].children[1].children[0].click();
    await flush();
    assert.equal(background.openedTabs[0].tabId, 7);
    assert.equal(background.openedTabs[0].url, 'https://www.youtube.com/watch?v=first');
    ui['delete-playlist'].click();
    await flush();
    assert.equal(background.playlists.length, 0);
    assert.equal(background.queue.length, 1);
});

test('popup refreshes when another view changes the shared queue and shows failures', async () => {
    const background = createBackground([], { tabs: [{ id: 1, url: 'chrome://extensions' }] });
    const ui = createPopup(background);
    await flush();
    await background.request('ADD_TO_QUEUE', { url: 'https://www.youtube.com/watch?v=other', title: '<Video>' });
    await flush();
    assert.equal(ui['queue-count'].textContent, '1 item');
    assert.equal(ui['queue-items'].children[0].children[1].children[0].textContent, '<Video>');
    assert.equal(ui['add-current'].disabled, true);
    ui['playlist-name'].value = '  ';
    ui['save-form'].submit();
    await flush();
    assert.equal(ui.status.dataset.error, 'true');
    assert.match(ui.status.textContent, /Enter a playlist name/);
    await background.request('CLEAR_QUEUE');
    await flush();
    assert.equal(ui['queue-count'].textContent, '0 items');
    assert.equal(ui.clear.disabled, true);
});

test('saved playlist titles open videos even when the active queue is empty', async () => {
    const background = createBackground([{ id: 'saved', title: 'Saved video', url: 'https://www.youtube.com/watch?v=saved' }], {
        tabs: [{ id: 7, url: 'https://www.youtube.com/watch?v=current' }],
    });
    await background.request('SAVE_PLAYLIST', { name: 'Saved' });
    await background.request('CLEAR_QUEUE');
    const ui = createPopup(background);
    await flush();
    ui['playlists-view'].click();
    ui['playlist-list'].children[0].click();
    const title = ui['playlist-items'].children[0].children[1].children[0];
    assert.equal(title.tag, 'button');
    title.click();
    await flush();
    assert.deepEqual(background.openedTabs, [{ tabId: 7, url: 'https://www.youtube.com/watch?v=saved', active: true }]);
    assert.equal(background.queue.length, 0);
    assert.equal(background.playlists[0].items.length, 1);
    assert.equal(ui.status.dataset.error, 'false');
});

test('popup imports the current tab YouTube queue and reports added and duplicate counts', async () => {
    const id = 'aaaaaaaaaaa';
    const background = createBackground([], {
        tabs: [{ id: 7, url: 'https://www.youtube.com/' }],
        youtubePage: {
            querySelectorAll: () => [],
            getElementById: () => ({ getPlaylistId: () => 'TQlocal', getPlaylist: () => [id] }),
        },
    });
    const ui = createPopup(background);
    await flush();
    assert.equal(ui['import-youtube-queue'].disabled, false);
    assert.equal(ui['add-current'].disabled, true);
    ui['import-youtube-queue'].click();
    assert.equal(ui['import-youtube-queue'].disabled, true);
    await flush();
    assert.equal(ui['queue-count'].textContent, '1 item');
    assert.equal(background.queue[0].id, id);
    assert.equal(ui.status.textContent, '1 added from YouTube queue · 0 already queued · 0 unavailable videos skipped');
    assert.equal(ui['import-youtube-queue'].disabled, false);
    ui['import-youtube-queue'].click();
    await flush();
    assert.match(ui.status.textContent, /0 added from YouTube queue · 1 already queued/);
});

test('popup disables queue import outside YouTube and shows an error for missing native queues', async () => {
    const otherSite = createPopup(createBackground([], { tabs: [{ id: 1, url: 'https://example.com' }] }));
    await flush();
    assert.equal(otherSite['import-youtube-queue'].disabled, true);
    const ui = createPopup(createBackground([], { tabs: [{ id: 7, url: 'https://www.youtube.com/' }] }));
    await flush();
    ui['import-youtube-queue'].click();
    await flush();
    assert.equal(ui.status.dataset.error, 'true');
    assert.match(ui.status.textContent, /No built-in YouTube queue found/);
    assert.equal(ui['import-youtube-queue'].disabled, false);
    assert.equal(ui['queue-count'].textContent, '0 items');
});
