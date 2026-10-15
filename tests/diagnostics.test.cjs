const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { createBackground } = require('./helpers/background.cjs');

// DOM-shaped nodes let privacy tests exercise the serializer on live values,
// including form properties, ancestor exclusion and an open shadow root.
function element(tag, attributes = {}, children = []) {
    const node = {
        nodeType: 1, localName: tag, attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
        childNodes: children.map(child => typeof child === 'string' ? { nodeType: 3, textContent: child } : child),
        getAttribute: name => attributes[name] ?? null,
        hasAttribute: name => name in attributes,
        closest(selector) {
            const matches = selector.split(',').some(part => {
                part = part.trim();
                if (part === '[contenteditable]') return this.hasAttribute('contenteditable');
                if (part.startsWith('#')) return attributes.id === part.slice(1);
                return part === tag;
            });
            return matches ? this : this.parentElement?.closest(selector) || null;
        },
    };
    node.childNodes.forEach(child => { child.parentElement = node; });
    return node;
}

function diagnosticPage() {
    const link = element('a', { href: '/watch?v=aaaaaaaaaaa&token=private-query', title: 'A video' }, ['A video']);
    const unknownCard = element('brand-new-youtube-card', { class: 'changedLayout' }, [link, '123 views · 2 days ago · 4:12']);
    const watchMetadata = element('ytd-watch-metadata', {}, ['1,234 views', element('span', { datetime: '2026-10-15' }, ['Added today'])]);
    const root = element('html', {}, [element('body', {}, [unknownCard, watchMetadata])]);
    root.lang = 'en';
    return { documentElement: root, readyState: 'complete', hidden: false,
        querySelectorAll(selector) {
            if (selector === '*') return [root, unknownCard, link, watchMetadata];
            if (selector === 'a[href]') return [link];
            if (selector.startsWith('ytd-watch-metadata,')) return [watchMetadata];
            return [];
        },
        getElementById: () => null,
    };
}

function collector(document = diagnosticPage()) {
    const context = { URL, location: { href: 'https://www.youtube.com/watch?v=aaaaaaaaaaa&token=private-query#secret' }, document };
    vm.runInNewContext(fs.readFileSync(`${__dirname}/../services/diagnostics.js`, 'utf8'), context);
    return context.QueueDiagnostics;
}

test('snapshot removes private regions, credentials and unsafe attributes while preserving diagnostic markup', () => {
    const diagnostics = collector();
    const account = element('ytd-masthead', { title: 'Private account', 'aria-label': 'Private identity' }, ['Private identity']);
    const form = element('input', { value: 'private-input', placeholder: 'private-placeholder', 'aria-label': 'private-label' });
    form.value = 'private-live-input';
    const root = element('div', { onclick: 'private-handler', 'data-token': 'private-data' }, [
        account, form,
        element('textarea', {}, ['private-textarea']), element('div', { contenteditable: 'true' }, ['private-editor']),
        element('ytd-comments', {}, ['private-comment']), element('iframe', { src: 'private-frame' }, ['private-frame-content']),
        element('script', { src: 'private-script-url' }, ['private-script']), element('style', {}, ['private-style']),
        element('a', { href: 'https://user:password@www.youtube.com/watch?v=aaaaaaaaaaa&auth_token=private-query#private-hash',
            title: 'reader@example.com' }, ['Visible title']),
        element('span', { 'aria-label': '123 views · 2 days ago' }, ['Bearer private-credential', ' password=private-password']),
    ]);
    root.shadowRoot = { childNodes: [element('span', {}, ['shadow metadata'])] };
    const snapshot = diagnostics.snapshot(root);
    assert.doesNotMatch(snapshot.html, /private-|Private identity|Private account|reader@example.com/);
    assert.match(snapshot.html, /watch\?v=aaaaaaaaaaa/);
    assert.match(snapshot.html, /123 views · 2 days ago/);
    assert.match(snapshot.html, /Visible title/);
    assert.match(snapshot.html, /data-report-shadow-root/);
    assert.match(snapshot.html, /shadow metadata/);
    // A sample rooted inside an excluded area must also remain private.
    assert.doesNotMatch(diagnostics.snapshot(account.childNodes[0].parentElement).html, /Private identity/);
    assert.equal(snapshot.characters, snapshot.html.length);
});

test('snapshot enforces character and node budgets and marks truncation', () => {
    const diagnostics = collector();
    const root = element('div', {}, Array.from({ length: 100 }, () => element('span', {}, ['lots of text'])));
    const byCharacters = diagnostics.snapshot(root, { maxNodes: 10000, maxCharacters: 100 });
    assert.equal(byCharacters.html.length, 100);
    assert.equal(byCharacters.truncated, true);
    const byNodes = diagnostics.snapshot(root, { maxNodes: 5, maxCharacters: 10000 });
    assert.equal(byNodes.nodesVisited, 5);
    assert.equal(byNodes.truncated, true);
});

test('independent evidence survives absent and throwing adapters and unknown card names', () => {
    const diagnostics = collector();
    const report = diagnostics.capture();
    assert.match(report.extensionState.error, /unavailable/);
    assert.equal(report.page.url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
    assert.equal(report.selectorMatches['.ytLockupViewModelHost'], 0);
    assert.equal(report.independentCapture.uniqueVideoLinks, 1);
    assert.match(report.independentCapture.links[0].context.html, /brand-new-youtube-card/);
    assert.match(report.independentCapture.regions[0].context.html, /1,234 views/);
    assert.doesNotMatch(JSON.stringify(report), /private-query/);
    diagnostics.setStateProvider(() => { throw new Error('obsolete selector'); });
    assert.equal(diagnostics.capture().extensionState.error, 'obsolete selector');
    assert.match(diagnostics.capture().independentCapture.dom.html, /brand-new-youtube-card/);
});

test('events are bounded and redact error URLs and credential fields', () => {
    const diagnostics = collector();
    for (let i = 0; i < 100; i++) diagnostics.record('action', { i, password: 'private-password',
        error: 'reader@example.com https://youtube.com/watch?v=aaaaaaaaaaa&token=private-query Bearer private-credential' });
    assert.equal(diagnostics.getEvents().length, 80);
    assert.equal(diagnostics.getEvents()[0].i, 20);
    assert.doesNotMatch(JSON.stringify(diagnostics.getEvents()), /private-|reader@example.com/);
});

test('runtime listeners capture extension failures and ignore unrelated page errors', () => {
    const listeners = {};
    const context = { URL, addEventListener: (type, listener) => { listeners[type] = listener; },
        chrome: { runtime: { getURL: () => 'chrome-extension://test/' } } };
    vm.runInNewContext(fs.readFileSync(`${__dirname}/../services/diagnostics.js`, 'utf8'), context);
    listeners.error({ filename: 'https://www.youtube.com/player.js', message: 'private-page-error' });
    listeners.unhandledrejection({ reason: { stack: 'https://youtube.com/player.js', message: 'private-page-rejection' } });
    assert.equal(context.QueueDiagnostics.getEvents().length, 0);
    listeners.error({ filename: 'chrome-extension://test/main.js', message: 'Broken selector', lineno: 12 });
    listeners.unhandledrejection({ reason: { stack: 'at chrome-extension://test/main.js:24', message: 'Worker disconnected' } });
    assert.equal(context.QueueDiagnostics.getEvents().length, 2);
    assert.equal(context.QueueDiagnostics.getEvents()[0].line, 12);
    assert.equal(context.QueueDiagnostics.getEvents()[1].error, 'Worker disconnected');
});

test('worker exports page and queue evidence without mutating queues or relying on main.js', async () => {
    const queue = [{ id: 'aaaaaaaaaaa', url: 'https://youtube.com/watch?v=aaaaaaaaaaa', title: 'reader@example.com', customSecret: 'do not export' }];
    const background = createBackground(queue, { tabs: [{ id: 7, url: 'https://www.youtube.com/' }], diagnosticPage: diagnosticPage() });
    const response = await background.request('CREATE_DIAGNOSTIC_REPORT');
    assert.equal(response.success, true);
    assert.equal(response.data.errors.length, 0);
    assert.match(response.data.youtube.independentCapture.dom.html, /brand-new-youtube-card/);
    assert.match(response.data.youtube.extensionState.error, /unavailable/);
    assert.equal(response.data.state.queueCount, 1);
    assert.doesNotMatch(JSON.stringify(response.data), /reader@example.com|do not export/);
    assert.equal(background.storageWrites, 0);
    assert.deepEqual(background.queue, queue);
    assert.deepEqual(Array.from(background.scriptCalls[0].files), ['services/diagnostics.js']);
    assert.equal(background.scriptCalls.at(-1).world, 'MAIN');
    assert.equal(background.openedTabs.length, 0);
});

test('native queue failures and inaccessible pages still produce usable partial reports', async () => {
    const nativeFailure = createBackground([], { tabs: [{ id: 7, url: 'https://www.youtube.com/' }],
        diagnosticPage: diagnosticPage(), nativeScriptError: 'Changed player API' });
    const native = (await nativeFailure.request('CREATE_DIAGNOSTIC_REPORT')).data;
    assert.ok(native.youtube.independentCapture.dom.html);
    assert.deepEqual(native.errors, [{ stage: 'native-queue', error: 'Changed player API' }]);
    const inaccessible = createBackground([], { tabs: [{ id: 7, url: 'https://www.youtube.com/' }], scriptError: 'Cannot access tab' });
    const partial = (await inaccessible.request('CREATE_DIAGNOSTIC_REPORT')).data;
    assert.equal(partial.state.queueCount, 0);
    assert.deepEqual(partial.errors, [{ stage: 'page-capture', error: 'Cannot access tab' }]);
});

test('non-YouTube reports omit other-site URLs and do not run page scripts or migrate legacy queues', async () => {
    const background = createBackground([{ id: 'legacy' }], { migrate: true,
        tabs: [{ id: 3, url: 'https://private.example/sensitive?secret=abc' }] });
    const report = (await background.request('CREATE_DIAGNOSTIC_REPORT')).data;
    assert.match(report.youtube.unavailable, /YouTube tab/);
    assert.equal(report.state.queueStorage, 'sync (legacy)');
    assert.equal(report.state.queueCount, 1);
    assert.equal(background.storageWrites, 0);
    assert.equal(background.scriptCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(report), /private.example|secret=abc/);
});

test('background action failures survive worker restarts in bounded session history', async () => {
    const sessionValues = {};
    const firstWorker = createBackground([], { sessionValues });
    await firstWorker.request('SAVE_PLAYLIST', { name: ' ' });
    await firstWorker.request('CREATE_DIAGNOSTIC_REPORT');
    const secondWorker = createBackground([], { sessionValues });
    const report = (await secondWorker.request('CREATE_DIAGNOSTIC_REPORT')).data;
    assert.ok(report.events.some(event => event.type === 'SAVE_PLAYLIST' && event.success === false && /playlist name/.test(event.error)));
});
