const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createBackground } = require('./helpers/background.cjs');

const playlist = ['first', 'middle', 'last'].map(id => ({ id, url: `https://www.youtube.com/watch?v=${id}` }));

test('playback advances from the finished video and preserves the entire playlist', async () => {
    const background = createBackground(playlist);
    for (const [currentVideoId, expectedNextVideo] of [['first', playlist[1]], ['middle', playlist[2]]]) {
        assert.deepEqual(await background.request('NEXT_VIDEO_REQUEST', { currentVideoId }), {
            success: true, data: expectedNextVideo,
        });
    }
    assert.deepEqual(background.queue, playlist);
    assert.equal(background.storageWrites, 0);
});

test('the final video and videos outside the playlist have no next queue item', async () => {
    const background = createBackground(playlist);
    for (const currentVideoId of ['last', 'unlisted', undefined]) {
        assert.deepEqual(await background.request('NEXT_VIDEO_REQUEST', { currentVideoId }), {
            success: true, data: null,
        });
    }
    assert.deepEqual(background.queue, playlist);
    assert.equal(background.storageWrites, 0);
    assert.deepEqual(await createBackground([]).request('NEXT_VIDEO_REQUEST', { currentVideoId: 'first' }), {
        success: true, data: null,
    });
});

test('playback uses the latest order when a reorder request is still in progress', async () => {
    const background = createBackground(playlist);
    const reorder = background.request('REORDER_QUEUE', { fromIndex: 2, toIndex: 1 });
    const nextVideo = background.request('NEXT_VIDEO_REQUEST', { currentVideoId: 'first' });
    await reorder;
    assert.deepEqual(await nextVideo, { success: true, data: playlist[2] });
    assert.deepEqual(background.queue, [playlist[0], playlist[2], playlist[1]]);
    assert.equal(background.storageWrites, 1);
});


test('non-YouTube tabs are rejected without injection', async () => {
    const background = createBackground([], { tabs: [{ id: 5, url: 'https://www.twitch.tv/channel', title: 'Live stream' }] });
    assert.equal((await background.request('ADD_CURRENT')).success, false);
    assert.equal((await background.request('ADD_TO_QUEUE', { url: 'https://example.com/video' })).success, false);
    assert.equal(background.queue.length, 0);
    assert.deepEqual(background.injectedTabs, []);
});

test('all tabs collects only YouTube videos, deduplicates URLs, and publishes queue changes', async () => {
    const background = createBackground([], { tabs: [
        { id: 1, url: 'https://www.youtube.com/watch?v=first', title: 'Video' },
        { id: 2, url: 'https://www.twitch.tv/channel', title: 'Stream' },
        { id: 3, url: 'https://www.youtube.com/watch?v=last', title: 'Last video' },
        { id: 4, url: 'chrome://extensions' },
        { id: 5, url: 'https://youtu.be/first' },
    ] });
    assert.deepEqual(await background.request('QUEUE_ALL_TABS'), {
        success: true, data: { added: 2, duplicates: 1, skipped: 2 },
    });
    assert.equal(background.queue.length, 2);
    assert.ok(background.injectedTabs.every(id => [1, 3].includes(id)));
    assert.deepEqual((await background.request('NEXT_VIDEO_REQUEST', { currentVideoId: 'first' })).data, background.queue[1]);
    assert.equal(background.queue.length, 2);
    const item = background.queue[1];
    await background.request('PLAY_QUEUE_ITEM', { id: item.id, tabId: 1 });
    assert.deepEqual(background.openedTabs, [{ tabId: 1, url: item.url, active: true }]);
    assert.deepEqual([...new Set(background.tabMessages.filter(message => message.type === 'QUEUE_UPDATED').map(message => message.tabId))], [1, 3]);
});

test('saved playlists are independent snapshots with rename, reorder, removal, load, update and delete', async () => {
    const background = createBackground(playlist);
    const saved = await background.request('SAVE_PLAYLIST', { name: ' My mix ' });
    assert.equal(saved.success, true);
    const id = saved.data.id;
    assert.equal(saved.data.name, 'My mix');
    await background.request('CLEAR_QUEUE');
    assert.equal(background.playlists[0].items.length, 3);
    await background.request('UPDATE_PLAYLIST', { id, name: 'Renamed', fromIndex: 2, toIndex: 0 });
    await background.request('UPDATE_PLAYLIST', { id, removeItemId: 'middle' });
    assert.equal(background.playlists[0].name, 'Renamed');
    assert.deepEqual(background.playlists[0].items.map(item => item.id), ['last', 'first']);
    await background.request('LOAD_PLAYLIST', { id });
    assert.deepEqual(background.queue.map(item => item.id), ['last', 'first']);
    await background.request('ADD_TO_QUEUE', { url: 'https://www.youtube.com/watch?v=extra', title: 'Extra' });
    assert.equal(background.queue.length, 3);
    assert.equal(background.playlists[0].items.length, 2);
    await background.request('UPDATE_PLAYLIST', { id, replaceWithQueue: true });
    assert.equal(background.playlists[0].items.length, 3);
    await background.request('DELETE_PLAYLIST', { id });
    assert.deepEqual(background.playlists, []);
    assert.equal(background.queue.length, 3);
});

test('queue migration is shared by concurrent readers and preserves later mutations', async () => {
    const background = createBackground(playlist, { migrate: true });
    await Promise.all([
        background.request('GET_QUEUE'),
        background.request('ADD_TO_QUEUE', { url: 'https://www.youtube.com/watch?v=added', title: 'Added' }),
        background.request('GET_QUEUE'),
    ]);
    assert.deepEqual(background.queue.slice(0, 3), playlist);
    assert.equal(background.queue.length, 4);
    assert.equal(background.storageWrites, 2);
});

test('empty local queues do not resurrect old queues and invalid input returns errors', async () => {
    const background = createBackground([]);
    assert.deepEqual((await background.request('GET_QUEUE')).data, []);
    assert.equal(background.storageWrites, 0);
    for (const url of ['javascript:alert(1)', 'file:///tmp/video', 'not a url']) {
        assert.equal((await background.request('ADD_TO_QUEUE', { url })).success, false);
    }
    assert.equal((await background.request('SAVE_PLAYLIST', { name: '  ' })).success, false);
    assert.equal((await background.request('LOAD_PLAYLIST', { id: 'missing' })).success, false);
    assert.equal(background.queue.length, 0);
});


test('loading a playlist refreshes every open YouTube video tab even when the active tab is elsewhere', async () => {
    const background = createBackground(playlist, { tabs: [
        { id: 1, url: 'https://example.com' },
        { id: 2, url: 'https://www.youtube.com/watch?v=first' },
        { id: 3, url: 'https://www.youtube.com/watch?v=last' },
    ] });
    const { data: saved } = await background.request('SAVE_PLAYLIST', { name: 'Saved' });
    await background.request('CLEAR_QUEUE');
    background.tabMessages.length = 0;
    assert.equal((await background.request('LOAD_PLAYLIST', { id: saved.id })).success, true);
    assert.deepEqual(background.tabMessages.filter(message => message.type === 'QUEUE_UPDATED').map(message => message.tabId), [2, 3]);
    assert.equal(background.openedTabs.length, 0);
    assert.equal(background.queue.length, 3);
});

test('adding current video directly to a saved playlist does not modify the active queue', async () => {
    const background = createBackground(playlist, { tabs: [{ id: 1, url: 'https://www.youtube.com/watch?v=new', title: 'New video' }] });
    const { data: saved } = await background.request('SAVE_PLAYLIST', { name: 'Saved' });
    const before = structuredClone(background.queue);
    assert.deepEqual(await background.request('ADD_CURRENT_TO_PLAYLIST', { id: saved.id }), { success: true, data: true });
    assert.deepEqual(await background.request('ADD_CURRENT_TO_PLAYLIST', { id: saved.id }), { success: true, data: false });
    assert.equal(background.playlists[0].items.length, 4);
    assert.equal(background.playlists[0].items[3].id, 'new');
    assert.deepEqual(background.queue, before);
});

test('older cross-site entries are excluded from queue views without an automatic destructive rewrite', async () => {
    const existing = [...playlist, { id: 'url:https://www.twitch.tv/channel', url: 'https://www.twitch.tv/channel', title: 'Stream' }];
    const background = createBackground(existing);
    assert.deepEqual((await background.request('GET_QUEUE')).data, playlist);
    assert.deepEqual(background.queue, existing);
    assert.equal(background.storageWrites, 0);
});
