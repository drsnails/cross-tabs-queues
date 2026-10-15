const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { Element } = require('./helpers/dom.cjs');
const now = Date.UTC(2026, 9, 15, 12);

function setup(fixture = 'watch-metadata') {
    const root = new Element(require(`./fixtures/${fixture}.json`));
    const document = { documentElement: { lang: 'en' },
        querySelector: selector => root.querySelector(selector), querySelectorAll: selector => root.querySelectorAll(selector) };
    const context = { URL, document, location: { href: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', pathname: '/watch' } };
    vm.runInNewContext(fs.readFileSync(`${__dirname}/../services/video-metadata.js`, 'utf8'), context);
    return { reader: context.YouTubeMetadata, root };
}

test('parses exact, compact and accessible view counts without treating dates as views', () => {
    const { reader } = setup();
    for (const [text, expected] of [['947,263 views', 947263], ['5.4 million views', 5400000], ['357K views', 357000],
        ['1.2B views', 1200000000], ['No views', 0], ['0 views', 0], ['2 weeks ago', null], ['LIVE', null], ['bad data', null]]) {
        assert.equal(reader.parseViews(text), expected, text);
    }
    assert.equal(reader.parseViews('357K', true), 357000);
    assert.equal(reader.parseViews('357K'), null);
});

test('parses precise durations and refuses invalid clocks, live labels and video titles', () => {
    const { reader } = setup();
    for (const [text, expected] of [['18:15', 1095], ['1:02:03', 3723], ['PT1H2M3S', 3723],
        ['18 minutes, 15 seconds', 1095], ['9:99', null], ['LIVE', null], ['Episode 18 minutes', null]]) {
        assert.equal(reader.parseDuration(text), expected, text);
    }
});

test('upload dates use exact UTC dates or explicit relative estimates', () => {
    const { reader } = setup();
    assert.equal(reader.parsePublished('947,263 views • Oct 10, 2026 • #hashtag', now).timestamp, Date.UTC(2026, 9, 10));
    assert.equal(reader.parsePublished('2026-10-10', now).approximate, false);
    for (const text of ['2 weeks ago', '2w ago']) {
        const date = reader.parsePublished(text, now);
        assert.equal(date.timestamp, Date.UTC(2026, 9, 1));
        assert.equal(date.approximate, true);
    }
    assert.equal(reader.parsePublished('2026-02-30', now), null);
    assert.equal(reader.parsePublished('947K views', now), null);
});

test('suggestion and channel fixtures supply views, upload date and exact badge duration', () => {
    for (const [fixture, views, duration] of [['suggested-video', 5400000, 1095], ['channel-video', 357000, 632]]) {
        const { reader, root } = setup(fixture);
        const metadata = reader.readCard(root.querySelector('.ytLockupViewModelHost'), { now });
        assert.equal(metadata.views, views);
        assert.equal(metadata.publishedAt, Date.UTC(2026, 9, 1));
        assert.equal(metadata.publishedAtApproximate, true);
        assert.equal(metadata.durationSeconds, duration);
        assert.match(metadata.metadataEvidence.fields.views.source, /aria-label/);
    }
});

test('missing and changed card metadata produce unknowns with raw diagnostic evidence', () => {
    const { reader, root } = setup('channel-video');
    const card = root.querySelector('.ytLockupViewModelHost');
    for (const node of card.querySelectorAll('.ytContentMetadataViewModelMetadataText')) {
        node.setAttribute('aria-label', 'New YouTube format'); node.textContent = 'New format';
    }
    card.querySelector('yt-thumbnail-badge-view-model').remove();
    const metadata = reader.readCard(card, { now });
    assert.equal(metadata.views, null);
    assert.equal(metadata.publishedAt, null);
    assert.equal(metadata.durationSeconds, null);
    assert.equal(metadata.metadataEvidence.fields.views.status, 'unrecognized');
    assert.match(JSON.stringify(metadata.metadataEvidence.fields.views.samples), /New YouTube format/);
    assert.equal(metadata.metadataEvidence.fields.durationSeconds.status, 'missing');
    const diagnostic = reader.describePage();
    assert.equal(diagnostic.missingInCardSamples.views, 1);
});

test('playlist card totals are never attached to its first video', () => {
    const { reader, root } = setup('home-playlist');
    const metadata = reader.readCard(root.querySelector('.ytLockupViewModelHost'), { isPlaylist: true });
    assert.equal(metadata.views, null);
    assert.equal(metadata.publishedAt, null);
    assert.equal(metadata.durationSeconds, null);
    assert.equal(metadata.metadataEvidence.fields.views.status, 'not-applicable');
});

test('supplied watch markup prefers exact tooltip views/date and reads the playing video length', () => {
    const { reader, root } = setup();
    const video = new Element({ tag: 'video', attributes: { class: 'html5-main-video' }, children: [] });
    video.duration = 1095;
    root.appendChild(video);
    const metadata = reader.readWatch('aaaaaaaaaaa', now);
    assert.equal(metadata.views, 947263);
    assert.equal(metadata.publishedAt, Date.UTC(2026, 9, 10));
    assert.equal(metadata.publishedAtApproximate, false);
    assert.equal(metadata.durationSeconds, 1095);
    assert.match(metadata.metadataEvidence.fields.views.source, /tooltip/);
});

test('stale navigation, stale head tags and advertisements cannot supply another video metadata', () => {
    const { reader, root } = setup();
    for (const [itemprop, content] of [['videoId', 'bbbbbbbbbbb'], ['interactionCount', '99999999'], ['duration', 'PT30S']]) {
        root.appendChild(new Element({ tag: 'meta', attributes: { itemprop, content }, children: [] }));
    }
    const ad = new Element({ tag: 'div', attributes: { id: 'movie_player', class: 'ad-showing' }, children: [] });
    const video = new Element({ tag: 'video', attributes: { class: 'html5-main-video' }, children: [] });
    video.duration = 30;
    root.appendChild(ad); root.appendChild(video);
    const metadata = reader.readWatch('aaaaaaaaaaa', now);
    assert.equal(metadata.views, 947263);
    assert.equal(metadata.durationSeconds, null);
    assert.equal(reader.watchIdentity('bbbbbbbbbbb'), false);
    const stale = reader.readWatch('bbbbbbbbbbb', now);
    assert.equal(stale.views, null);
    assert.equal(stale.publishedAt, null);
    assert.equal(stale.durationSeconds, null);
});

test('matching head tags provide metadata for loading pages without rendered info', () => {
    const { reader, root } = setup();
    root.querySelector('ytd-watch-info-text').remove();
    for (const [itemprop, content] of [['videoId', 'aaaaaaaaaaa'], ['interactionCount', '947263'], ['datePublished', '2026-10-10'], ['duration', 'PT18M15S']]) {
        root.appendChild(new Element({ tag: 'meta', attributes: { itemprop, content }, children: [] }));
    }
    const metadata = reader.readWatch('aaaaaaaaaaa', now);
    assert.equal(metadata.views, 947263);
    assert.equal(metadata.durationSeconds, 1095);
    assert.equal(metadata.publishedAt, Date.UTC(2026, 9, 10));
});

test('live playback stays unknown even if a DVR time range resembles a fixed duration', () => {
    const { reader, root } = setup();
    const video = new Element({ tag: 'video', attributes: { class: 'html5-main-video' }, children: [] });
    video.duration = Infinity;
    root.appendChild(video);
    root.appendChild(new Element({ tag: 'span', attributes: { class: 'ytp-time-duration' }, children: ['20:00'] }));
    const metadata = reader.readWatch('aaaaaaaaaaa', now);
    assert.equal(metadata.durationSeconds, null);
    assert.equal(metadata.metadataEvidence.fields.durationSeconds.status, 'not-applicable');
});
