// Shared by the popup, worker and isolated content world. Page capture deliberately
// does not depend on preview detection or on main.js having initialized successfully.
(() => {
    "use strict";
    if (globalThis.QueueDiagnostics) return;
    const events = [];
    let describeState;
    const PRIVATE_REGIONS = 'ytd-masthead, ytd-active-account-header-renderer, ytd-account-section-list-renderer, ytd-account-item-renderer, #account-menu, #avatar-btn, #sections.ytd-multi-page-menu-renderer, input, textarea, select, [contenteditable], ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model, ytd-live-chat-frame';
    const BLOCKED_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template']);
    const SAFE_ATTRIBUTES = new Set(['id', 'class', 'role', 'title', 'alt', 'name', 'type', 'hidden', 'disabled', 'datetime', 'itemprop', 'itemscope', 'itemtype', 'data-tooltip-text', 'd', 'viewBox']);

    function redact(value) {
        return String(value)
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
            .replace(/\bBearer\s+[\w.+/-]+=*/gi, '[credential removed]')
            .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[token removed]')
            .replace(/\b(?:AIza[\w-]{25,}|ya29\.[\w.-]+)\b/g, '[token removed]')
            .replace(/((?:access_token|auth_token|authorization|password|cookie|secret|api_key|session_token)\s*[=:]\s*)[^\s&"<>]+/gi, '$1[removed]');
    }

    function safeURL(value, base = globalThis.location?.href) {
        try {
            const url = new URL(value, base);
            if (!['http:', 'https:'].includes(url.protocol)) return null;
            url.username = ''; url.password = ''; url.hash = '';
            for (const key of [...url.searchParams.keys()]) {
                if (!['v', 'list', 'index', 't'].includes(key)) url.searchParams.delete(key);
            }
            return redact(url.href);
        } catch { return null; }
    }

    function scrub(value, depth = 0) {
        if (depth > 15) return '[depth limit]';
        if (typeof value === 'string') {
            // Errors may embed URLs with sensitive query parameters.
            return redact(value.replace(/https?:\/\/[^\s<>"']+/g, (url) => safeURL(url) || '[URL removed]')).slice(0, 4000);
        }
        if (Array.isArray(value)) return value.slice(0, 100).map(item => scrub(item, depth + 1));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [redact(key),
            /^(?:password|cookie|authorization|secret|access_token|auth_token|api_key|session_token)$/i.test(key) ? '[removed]' : scrub(item, depth + 1)]));
        return value;
    }

    function record(type, details = {}) {
        events.push(scrub({ at: new Date().toISOString(), type, ...details }));
        if (events.length > 80) events.shift();
    }

    const escapeHTML = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function snapshot(root, { maxNodes = 30000, maxCharacters = 2000000 } = {}) {
        let nodesVisited = 0, characters = 0, truncated = false;
        const parts = [];
        const append = value => {
            const remaining = maxCharacters - characters;
            if (value.length > remaining) truncated = true;
            parts.push(value.slice(0, remaining));
            characters += Math.min(value.length, remaining);
        };
        const visit = (node, depth = 0) => {
            if (nodesVisited >= maxNodes || characters >= maxCharacters || depth > 100) { truncated = true; return; }
            nodesVisited++;
            if (node.nodeType === 3) {
                const text = node.textContent || '';
                if (text.length > 4000) truncated = true;
                append(escapeHTML(scrub(text)));
                return;
            }
            if (node.nodeType !== 1) return;
            const tag = node.localName;
            if (!/^[\w-]+$/.test(tag)) return;
            const privateContent = Boolean(node.closest(PRIVATE_REGIONS));
            append(`<${tag}`);
            for (const { name, value } of node.attributes) {
                if (privateContent && !['id', 'class', 'role', 'hidden'].includes(name)) continue;
                let safeValue;
                if (name === 'href') safeValue = safeURL(value);
                else if (SAFE_ATTRIBUTES.has(name) || name.startsWith('aria-')) safeValue = scrub(value).slice(0, 1000);
                if (safeValue != null) append(` ${name}="${escapeHTML(safeValue)}"`);
                if (characters >= maxCharacters) break;
            }
            append('>');
            if (privateContent || BLOCKED_TAGS.has(tag)) append('[content omitted]');
            else {
                for (const child of node.childNodes) {
                    visit(child, depth + 1);
                    if (nodesVisited >= maxNodes || characters >= maxCharacters) { truncated = true; break; }
                }
                if (node.shadowRoot) {
                    append('<template data-report-shadow-root="open">');
                    for (const child of node.shadowRoot.childNodes) {
                        visit(child, depth + 1);
                        if (nodesVisited >= maxNodes || characters >= maxCharacters) { truncated = true; break; }
                    }
                    append('</template>');
                }
            }
            append(`</${tag}>`);
        };
        if (root) visit(root);
        return { html: parts.join(''), truncated, nodesVisited, characters, limits: { maxNodes, maxCharacters } };
    }

    function capture() {
        // Capture the independent evidence before calling any extension adapters.
        const dom = snapshot(document.documentElement);
        const tagCounts = {}, attributeNames = {};
        let inspectedNodes = 0;
        for (const node of document.querySelectorAll('*')) {
            if (++inspectedNodes > 50000) break;
            tagCounts[node.localName] = (tagCounts[node.localName] || 0) + 1;
            for (const attribute of node.attributes) attributeNames[attribute.name] = (attributeNames[attribute.name] || 0) + 1;
        }
        const seen = new Set(), links = [];
        for (const link of document.querySelectorAll('a[href]')) {
            if (link.closest(PRIVATE_REGIONS)) continue;
            const href = safeURL(link.getAttribute('href'));
            if (!href) continue;
            const url = new URL(href);
            if (!(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))
                || !(url.pathname === '/watch' && url.searchParams.has('v') || url.pathname.startsWith('/shorts/'))
                || seen.has(href)) continue;
            seen.add(href);
            if (links.length >= 12) continue;
            // Fixed ancestor depth also works when card names and classes change.
            let context = link;
            for (let depth = 0; depth < 3 && context.parentElement; depth++) context = context.parentElement;
            links.push({ href, context: snapshot(context, { maxNodes: 500, maxCharacters: 24000 }) });
        }
        const regions = [...document.querySelectorAll('ytd-watch-metadata, ytd-video-primary-info-renderer, ytd-miniplayer, ytd-playlist-panel-renderer, #yt-queue-sidebar')]
            .slice(0, 8).map(node => ({ tag: node.localName, context: snapshot(node, { maxNodes: 2500, maxCharacters: 100000 }) }));
        const selectors = ['.ytLockupViewModelHost', 'yt-lockup-view-model', 'ytd-rich-grid-media', 'ytd-video-renderer', 'ytd-compact-video-renderer',
            'a.ytLockupViewModelContentImage', 'a.ytLockupMetadataViewModelTitle', 'h3[title]', '.ytContentMetadataViewModelMetadataRow',
            '#secondary', '#secondary-inner', '#top-level-buttons-computed', 'video.html5-main-video', '#yt-queue-btn-container', '#yt-queue-sidebar', '.yt-queue-preview-add-button'];
        const selectorMatches = Object.fromEntries(selectors.map(selector => [selector, document.querySelectorAll(selector).length]));
        const metadata = [...document.querySelectorAll('meta[itemprop], meta[property="og:title"], meta[property="og:type"]')]
            .filter(node => ['name', 'uploadDate', 'datePublished', 'duration', 'interactionCount'].includes(node.getAttribute('itemprop')) || node.hasAttribute('property'))
            .slice(0, 40).map(node => ({ field: node.getAttribute('itemprop') || node.getAttribute('property'), value: scrub(node.content || '').slice(0, 2000) }));
        let extensionState;
        try { extensionState = scrub(describeState ? describeState() : { error: 'Content script state is unavailable; independent capture succeeded.' }); }
        catch (error) { extensionState = { error: scrub(error.message) }; }
        return {
            capturedAt: new Date().toISOString(),
            page: { url: safeURL(location.href), language: document.documentElement.lang, readyState: document.readyState,
                hidden: document.hidden, viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight }, scrollY: globalThis.scrollY },
            selectorMatches, extensionState, metadata, events: events.slice(),
            independentCapture: { tagCounts, attributeNames, countsTruncated: inspectedNodes > 50000, uniqueVideoLinks: seen.size, links, regions, dom },
        };
    }

    globalThis.QueueDiagnostics = { redact, safeURL, scrub, snapshot, capture, record,
        getEvents: () => events.slice(), setStateProvider: provider => { describeState = provider; } };

    // Listen in the isolated extension world, and retain only errors attributed to
    // extension files. Do not collect unrelated YouTube errors or promise payloads.
    const isExtensionFile = value => {
        try { return typeof value === 'string' && value.includes(chrome.runtime.getURL('')); }
        catch { return false; }
    };
    globalThis.addEventListener?.('error', event => {
        if (isExtensionFile(event.filename)) record('script-error', { error: event.message, file: event.filename, line: event.lineno });
    });
    globalThis.addEventListener?.('unhandledrejection', event => {
        if (isExtensionFile(event.reason?.stack)) record('unhandled-rejection', { error: event.reason?.message });
    });
})();
