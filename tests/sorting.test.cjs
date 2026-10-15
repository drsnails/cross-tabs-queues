const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBackground } = require('./helpers/background.cjs');
const item = (id, fields = {}) => ({ id, title: id, url: `https://www.youtube.com/watch?v=${id}`, ...fields });

for (const field of ['views', 'publishedAt', 'durationSeconds']) {
    for (const direction of ['asc', 'desc']) {
        test(`${field} ${direction}: persists stable order, puts unknowns last and preserves the current video`, async () => {
            const queue = [item('unknown'), item('high', { [field]: 100 }), item('low', { [field]: 0 }),
                item('tie', { [field]: 100 }), item('null', { [field]: null }), item('invalid', { [field]: '999' })];
            const background = createBackground(queue, { tabs: [{ id: 7, url: 'https://www.youtube.com/watch?v=high' }] });
            const response = await background.request('SORT_QUEUE', { field, direction });
            assert.deepEqual(response, { success: true, data: { count: 6, missing: 3 } });
            const known = direction === 'asc' ? ['low', 'high', 'tie'] : ['high', 'tie', 'low'];
            assert.deepEqual(background.queue.map(item => item.id), [...known, 'unknown', 'null', 'invalid']);
            assert.equal(background.storageWrites, 1);
            assert.equal(background.openedTabs.length, 0);
            assert.ok(background.tabMessages.some(message => message.type === 'QUEUE_UPDATED'));
            const next = await background.request('NEXT_VIDEO_REQUEST', { currentVideoId: 'high' });
            assert.equal(next.data.id, 'tie');
        });
    }
}

test('sorting validates requests and serializes concurrent additions without losing items', async () => {
    const background = createBackground([item('high', { views: 100 })]);
    assert.equal((await background.request('SORT_QUEUE', { field: 'title', direction: 'asc' })).success, false);
    assert.equal((await background.request('SORT_QUEUE', { field: 'views', direction: 'sideways' })).success, false);
    assert.equal(background.storageWrites, 0);
    const add = background.request('ADD_TO_QUEUE', item('low', { views: 1 }));
    const sort = background.request('SORT_QUEUE', { field: 'views', direction: 'asc' });
    await Promise.all([add, sort]);
    assert.deepEqual(background.queue.map(item => item.id), ['low', 'high']);
});

test('card metadata survives normalization, saving/loading playlists, and sorting', async () => {
    const background = createBackground([]);
    const metadata = item('aaaaaaaaaaa', { views: 5400000, publishedAt: Date.UTC(2026, 9, 1), publishedAtApproximate: true,
        durationSeconds: 1095, metadataEvidence: { selectorVersion: 'fixture', surface: 'card', fields: { views: { source: 'aria-label' } } } });
    await background.request('ADD_TO_QUEUE', metadata);
    const addedAt = background.queue[0].addedAt;
    const saved = await background.request('SAVE_PLAYLIST', { name: 'With metadata' });
    await background.request('CLEAR_QUEUE');
    await background.request('LOAD_PLAYLIST', { id: saved.data.id });
    for (const field of ['views', 'publishedAt', 'publishedAtApproximate', 'durationSeconds', 'metadataEvidence']) {
        assert.deepEqual(background.queue[0][field], metadata[field]);
    }
    assert.equal(background.queue[0].addedAt, addedAt);
});

test('current-video and all-tabs additions store video page metadata', async () => {
    const metadata = item('aaaaaaaaaaa', { views: 947263, publishedAt: Date.UTC(2026, 9, 10), durationSeconds: 1095,
        metadataEvidence: { surface: 'watch', fields: { views: { source: 'tooltip' } } } });
    for (const action of ['ADD_CURRENT', 'QUEUE_ALL_TABS']) {
        const background = createBackground([], { tabs: [{ id: 7, url: metadata.url }], tabMetadata: metadata });
        const response = await background.request(action);
        assert.equal(response.success, true);
        assert.equal(background.queue[0].views, metadata.views);
        assert.equal(background.queue[0].publishedAt, metadata.publishedAt);
        assert.equal(background.queue[0].durationSeconds, metadata.durationSeconds);
        assert.equal(background.queue[0].metadataEvidence.surface, 'watch');
    }
});

test('invalid numeric metadata remains unknown rather than becoming a misleading sort value', async () => {
    const background = createBackground([]);
    await background.request('ADD_TO_QUEUE', item('invalid', { views: -1, publishedAt: '2026-10-15', durationSeconds: Infinity }));
    assert.equal(background.queue[0].views, null);
    assert.equal(background.queue[0].publishedAt, null);
    assert.equal(background.queue[0].durationSeconds, null);
});
