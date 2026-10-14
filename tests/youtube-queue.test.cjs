const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBackground } = require('./helpers/background.cjs');
const nativeQueue = require('./fixtures/youtube-native-queue.json');

const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
const tab = { id: 7, url: `https://www.youtube.com/watch?v=${ids[0]}` };
const item = id => ({ id, title: id, url: `https://www.youtube.com/watch?v=${id}` });
const entry = id => ({ playlistPanelVideoRenderer: {
    videoId: id, title: { runs: [{ text: 'Video ' }, { text: id }] },
    shortBylineText: { simpleText: 'Channel' },
} });

// Model both the panel's full data and its rendered subset. The injected function
// actually executes in a separate VM with only the page's document and location.
function page({ contents = ids.map(entry), playlistId = 'TQlocal', playerIds,
    panels, rows = [], hidden = false } = {}) {
    const panel = {
        data: { playlistId, contents },
        closest: () => hidden ? {} : null,
        querySelector: () => null,
        querySelectorAll: () => rows,
    };
    return {
        querySelectorAll: () => panels || [panel],
        getElementById: () => playerIds ? {
            getPlaylistId: () => playlistId,
            getPlaylist: () => playerIds,
        } : null,
    };
}

test('imports the entire current tab queue in order with metadata, deduplication and one write', async () => {
    const background = createBackground([item('existing'), item(ids[1])], {
        tabs: [tab, { id: 8, url: 'https://www.youtube.com/watch?v=unrelated' }],
        youtubePage: page({ contents: [...ids.map(entry), entry(ids[0])] }),
    });
    assert.deepEqual(await background.request('IMPORT_YOUTUBE_QUEUE'), {
        success: true, data: { added: 2, duplicates: 2, skipped: 0 },
    });
    assert.deepEqual(background.queue.map(video => video.id), ['existing', ids[1], ids[0], ids[2]]);
    assert.equal(background.queue[2].title, `Video ${ids[0]}`);
    assert.equal(background.queue[2].channel, 'Channel');
    assert.equal(background.queue[2].source, 'youtube');
    assert.equal(background.storageWrites, 1);
    assert.equal(background.scriptCalls.length, 1);
    assert.equal(background.scriptCalls[0].target.tabId, 7);
    assert.equal(background.scriptCalls[0].world, 'MAIN');
    assert.equal(background.openedTabs.length, 0);
    assert.deepEqual(background.tabMessages.filter(message => message.type === 'QUEUE_UPDATED').map(message => message.tabId), [7, 8]);
    const repeated = await background.request('IMPORT_YOUTUBE_QUEUE');
    assert.deepEqual(repeated.data, { added: 0, duplicates: 4, skipped: 0 });
    assert.equal(background.storageWrites, 1);
});

test('reads the miniplayer queue on YouTube home pages and ignores hidden stale panels', async () => {
    const youtubePage = page();
    const visible = youtubePage.querySelectorAll()[0];
    const hidden = page({ contents: [entry('ddddddddddd')], hidden: true }).querySelectorAll()[0];
    youtubePage.querySelectorAll = () => [hidden, visible];
    const background = createBackground([], { tabs: [{ id: 7, url: 'https://www.youtube.com/' }], youtubePage });
    assert.equal((await background.request('GET_POPUP_STATE')).data.canImportYouTubeQueue, true);
    assert.equal((await background.request('GET_POPUP_STATE')).data.canAddCurrent, false);
    assert.equal((await background.request('IMPORT_YOUTUBE_QUEUE')).data.added, 3);
    assert.deepEqual(background.queue.map(video => video.id), ids);
});

test('player IDs fill in videos missing from a partially rendered queue', async () => {
    const background = createBackground([], {
        tabs: [tab], youtubePage: page({ contents: [entry(ids[0])], playerIds: ids }),
    });
    assert.equal((await background.request('IMPORT_YOUTUBE_QUEUE')).data.added, 3);
    assert.deepEqual(background.queue.map(video => video.id), ids);
    assert.equal(background.queue[0].title, `Video ${ids[0]}`);
    assert.equal(background.queue[2].title, `YouTube video (${ids[2]})`);
});

test('imports player-only queues when the queue panel has not been mounted', async () => {
    const background = createBackground([], {
        tabs: [tab], youtubePage: page({ panels: [], playerIds: ids }),
    });
    assert.deepEqual((await background.request('IMPORT_YOUTUBE_QUEUE')).data, { added: 3, duplicates: 0, skipped: 0 });
    assert.deepEqual(background.queue.map(video => video.id), ids);
});

test('falls back to rendered queue links when Polymer data is unavailable', async () => {
    const link = { getAttribute: () => `/watch?v=${ids[0]}&list=TQlocal` };
    const row = { querySelector: selector => selector.startsWith('a[') ? link
        : { textContent: selector === '#video-title' ? 'DOM title' : 'DOM channel' } };
    const panel = {
        closest: () => null, querySelector: () => link, querySelectorAll: () => [row],
    };
    const background = createBackground([], { tabs: [tab], youtubePage: page({ panels: [panel] }) });
    assert.equal((await background.request('IMPORT_YOUTUBE_QUEUE')).data.added, 1);
    assert.equal(background.queue[0].title, 'DOM title');
    assert.equal(background.queue[0].channel, 'DOM channel');
});

test('imports all 20 TLPQ queue videos from the supplied markup without Polymer or player data', async () => {
    const rows = nativeQueue.videos.map(video => ({
        querySelector: selector => selector.startsWith('a[') ? { getAttribute: () => video.href }
            : selector === '#video-title' ? { textContent: video.title }
            : selector === '#byline' ? { textContent: video.channel } : null,
    }));
    const panel = {
        closest: () => null,
        querySelector: selector => selector === 'a[href*="list="]' ? rows[0].querySelector('a[href*="/watch?"]') : null,
        querySelectorAll: selector => selector === 'ytd-playlist-panel-video-renderer' ? rows : [],
    };
    const background = createBackground([], { tabs: [tab], youtubePage: page({ panels: [panel] }) });
    assert.deepEqual(await background.request('IMPORT_YOUTUBE_QUEUE'), {
        success: true, data: { added: 20, duplicates: 0, skipped: 0 },
    });
    assert.deepEqual(background.queue.map(({ id, title, channel }) => ({ id, title, channel })),
        nativeQueue.videos.map(({ id, title, channel }) => ({ id, title, channel })));
    assert.equal(background.storageWrites, 1);
});

test('recognizes TLPQ queues in panel data and player-only queues', async () => {
    const expectedIds = nativeQueue.videos.map(video => video.id);
    const contents = nativeQueue.videos.map(video => ({ playlistPanelVideoRenderer: {
        videoId: video.id, title: { simpleText: video.title }, shortBylineText: { simpleText: video.channel },
    } }));
    for (const youtubePage of [
        page({ playlistId: nativeQueue.playlistId, contents, playerIds: expectedIds }),
        page({ playlistId: nativeQueue.playlistId, panels: [], playerIds: expectedIds }),
    ]) {
        const background = createBackground([], { tabs: [tab], youtubePage });
        assert.deepEqual((await background.request('IMPORT_YOUTUBE_QUEUE')).data, { added: 20, duplicates: 0, skipped: 0 });
        assert.deepEqual(background.queue.map(video => video.id), expectedIds);
    }
});

test('skips invalid or unavailable videos while importing playable queue entries', async () => {
    const contents = [entry(ids[0]), entry('invalid'), entry(ids[1]), entry(ids[2])];
    contents[2].playlistPanelVideoRenderer.isPlayable = false;
    contents.push({ continuationItemRenderer: {} });
    const background = createBackground([], { tabs: [tab], youtubePage: page({ contents }) });
    assert.deepEqual((await background.request('IMPORT_YOUTUBE_QUEUE')).data, { added: 2, duplicates: 0, skipped: 2 });
    assert.deepEqual(background.queue.map(video => video.id), [ids[0], ids[2]]);
});

test('reports entirely unavailable queues without modifying storage', async () => {
    const contents = [entry(ids[0])];
    contents[0].playlistPanelVideoRenderer.isPlayable = false;
    const background = createBackground([], { tabs: [tab], youtubePage: page({ contents }) });
    assert.deepEqual((await background.request('IMPORT_YOUTUBE_QUEUE')).data, { added: 0, duplicates: 0, skipped: 1 });
    assert.equal(background.storageWrites, 0);
});

test('does not import saved YouTube playlists, mixes, empty queues or recommendations', async () => {
    for (const youtubePage of [page({ playlistId: 'PLsaved', playerIds: ids }),
        page({ playlistId: 'RDmix', playerIds: ids }), page({ contents: [] }), page({ panels: [] })]) {
        const background = createBackground([item('existing')], { tabs: [tab], youtubePage });
        const response = await background.request('IMPORT_YOUTUBE_QUEUE');
        assert.equal(response.success, false);
        assert.match(response.error, /No built-in YouTube queue found/);
        assert.deepEqual(background.queue, [item('existing')]);
        assert.equal(background.storageWrites, 0);
    }
});

test('rejects other sites and missing tabs before running a page script', async () => {
    for (const tabs of [[], [{ id: 1, url: 'https://example.com/' }],
        [{ id: 1, url: 'https://youtube.com.example.com/watch?v=aaaaaaaaaaa' }]]) {
        const background = createBackground([], { tabs });
        assert.equal((await background.request('GET_POPUP_STATE')).data.canImportYouTubeQueue, false);
        const response = await background.request('IMPORT_YOUTUBE_QUEUE');
        assert.equal(response.success, false);
        assert.match(response.error, /Open a YouTube tab/);
        assert.equal(background.scriptCalls.length, 0);
        assert.equal(background.storageWrites, 0);
    }
});

test('script failures leave the queue unchanged and explain how to retry', async () => {
    const background = createBackground([item('existing')], { tabs: [tab], scriptError: 'Tab closed' });
    const response = await background.request('IMPORT_YOUTUBE_QUEUE');
    assert.equal(response.success, false);
    assert.match(response.error, /Reload the tab and try again/);
    assert.deepEqual(background.queue, [item('existing')]);
    assert.equal(background.storageWrites, 0);
});

test('concurrent imports and additions preserve all videos without duplicates', async () => {
    const background = createBackground([], { tabs: [tab], youtubePage: page() });
    const results = await Promise.all([
        background.request('IMPORT_YOUTUBE_QUEUE'),
        background.request('ADD_TO_QUEUE', item('another')),
        background.request('IMPORT_YOUTUBE_QUEUE'),
    ]);
    assert.ok(results.every(response => response.success));
    assert.deepEqual([...background.queue.map(video => video.id)].sort(), [...ids, 'another'].sort());
    const imported = background.queue.filter(video => ids.includes(video.id)).map(video => video.id);
    assert.deepEqual(imported, ids);
});
