// Read only rendered metadata and identity-checked page tags. No network requests.
(() => {
    if (globalThis.YouTubeMetadata) return;
    const selectorVersion = "2026-10-15.2";
    const selectors = {
        cardText: '.ytContentMetadataViewModelMetadataText',
        cardDuration: 'yt-thumbnail-badge-view-model .ytBadgeShapeText',
        watchTooltip: 'ytd-watch-info-text #tooltip',
        watchInfo: 'ytd-watch-info-text #info',
        watchViews: 'ytd-watch-info-text #view-count',
        watchDate: 'ytd-watch-info-text #date-text',
        playerDuration: '.ytp-time-duration',
    };
    const clean = value => String(value || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
    const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const compactViews = new Intl.NumberFormat('en', { notation: 'compact', compactDisplay: 'short' });

    function parseViews(value, allowBare = false) {
        const text = clean(value);
        if (/^no views$/i.test(text)) return 0;
        const match = text.match(/(?:^|\b)(\d[\d,. ]*?)\s*(thousand|million|billion|[kmb])?\s*views?\b/i)
            || (allowBare && text.match(/^(\d[\d,. ]*?)\s*(thousand|million|billion|[kmb])?$/i));
        if (!match) return null;
        const suffix = match[2]?.toLowerCase();
        let numeric = match[1].trim().replace(/ /g, '');
        if (suffix && /^\d+,\d{1,2}$/.test(numeric)) numeric = numeric.replace(',', '.');
        else numeric = numeric.replace(/,/g, '');
        if (!/^\d+(?:\.\d+)?$/.test(numeric)) return null;
        const multiplier = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 }[suffix] || 1;
        const result = Math.round(Number(numeric) * multiplier);
        return Number.isSafeInteger(result) ? result : null;
    }

    function parseDuration(value) {
        const text = clean(value);
        const iso = text.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
        if (iso && iso.slice(1).some(Boolean)) return Number(iso[1] || 0) * 86400 + Number(iso[2] || 0) * 3600 + Number(iso[3] || 0) * 60 + Number(iso[4] || 0);
        if (/^\d{1,4}:\d{2}(?::\d{2})?$/.test(text)) {
            const parts = text.split(':').map(Number);
            if (parts.slice(1).some(part => part >= 60)) return null;
            return parts.reduce((total, part) => total * 60 + part, 0);
        }
        // Use only dedicated duration labels, never a title containing a number.
        if (/^(?:\d+\s*(?:hours?|minutes?|seconds?)[, ]*)+$/i.test(text)) {
            let seconds = 0;
            for (const match of text.matchAll(/(\d+)\s*(hours?|minutes?|seconds?)/gi)) {
                seconds += Number(match[1]) * (/hour/i.test(match[2]) ? 3600 : /minute/i.test(match[2]) ? 60 : 1);
            }
            return seconds;
        }
        return null;
    }

    function parsePublished(value, now = Date.now()) {
        const text = clean(value);
        const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const absolute = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i);
        if (iso || absolute) {
            const year = Number(iso ? iso[1] : absolute[3]);
            const month = iso ? Number(iso[2]) - 1 : months.indexOf(absolute[1].slice(0, 3).toLowerCase());
            const day = Number(iso ? iso[3] : absolute[2]);
            const date = new Date(Date.UTC(year, month, day));
            if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
            return { timestamp: date.getTime(), approximate: false };
        }
        const relative = text.match(/\b(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?|mo|years?|y)\s+ago\b/i);
        if (!relative) return null;
        const unit = relative[2].toLowerCase();
        const factor = /^y/.test(unit) ? 365 * 86400 : /^mo/.test(unit) ? 30 * 86400 : /^w/.test(unit) ? 7 * 86400
            : /^d/.test(unit) ? 86400 : /^h/.test(unit) ? 3600 : /^m/.test(unit) ? 60 : 1;
        // Equal day/week/month labels should not reorder based on the capture time.
        const reference = factor >= 86400 ? Math.floor(now / 86400000) * 86400000 : Math.floor(now / 60000) * 60000;
        return { timestamp: Math.max(0, reference - Number(relative[1]) * factor * 1000), approximate: true };
    }

    function result(surface) {
        return { views: null, publishedAt: null, durationSeconds: null, publishedAtApproximate: false,
            metadataEvidence: { selectorVersion, surface, capturedAt: Date.now(), fields: {} } };
    }

    function choose(output, field, candidates, parser) {
        for (const candidate of candidates) {
            const value = parser(candidate.raw);
            if (value === null) continue;
            output[field] = field === 'publishedAt' ? value.timestamp : value;
            if (field === 'publishedAt') output.publishedAtApproximate = value.approximate;
            output.metadataEvidence.fields[field] = { status: 'parsed', source: candidate.source, raw: clean(candidate.raw).slice(0, 300) };
            return;
        }
        output.metadataEvidence.fields[field] = { status: candidates.some(candidate => clean(candidate.raw)) ? 'unrecognized' : 'missing',
            samples: candidates.filter(candidate => clean(candidate.raw)).slice(0, 3).map(candidate => ({ source: candidate.source, raw: clean(candidate.raw).slice(0, 300) })) };
    }

    function texts(root, selector) {
        return [...root.querySelectorAll(selector)].flatMap(node => [
            { source: `${selector} [aria-label]`, raw: node.getAttribute('aria-label') },
            { source: selector, raw: node.textContent },
        ]).filter(candidate => clean(candidate.raw));
    }

    function readCard(card, { isPlaylist = false, now = Date.now() } = {}) {
        const output = result('card');
        if (isPlaylist) {
            for (const field of ['views', 'publishedAt', 'durationSeconds']) output.metadataEvidence.fields[field] = { status: 'not-applicable', reason: 'Playlist metadata does not describe the first video.' };
            return output;
        }
        const candidates = texts(card, selectors.cardText);
        choose(output, 'views', candidates, text => parseViews(text));
        if (output.views === null) {
            // Channel cards may render "357K" without a visible "views" suffix.
            const rows = [...card.querySelectorAll('.ytContentMetadataViewModelMetadataRow')]
                .filter(row => row.querySelector('.ytContentMetadataViewModelLeadingIcon'));
            const bare = rows.flatMap(row => texts(row, selectors.cardText));
            for (const candidate of bare) {
                if (output.views !== null) break;
                const value = parseViews(candidate.raw, true);
                if (value !== null) {
                    output.views = value;
                    output.metadataEvidence.fields.views = { status: 'parsed', source: candidate.source, raw: clean(candidate.raw).slice(0, 300) };
                }
            }
        }
        choose(output, 'publishedAt', candidates, text => parsePublished(text, now));
        const duration = texts(card, selectors.cardDuration);
        const badges = texts(card, 'yt-thumbnail-badge-view-model badge-shape');
        choose(output, 'durationSeconds', [...duration, ...badges], parseDuration);
        if (output.durationSeconds === null && badges.some(candidate => /\blive\b/i.test(candidate.raw))) {
            output.metadataEvidence.fields.durationSeconds = { status: 'not-applicable', reason: 'Live video has no fixed length.' };
        }
        return output;
    }

    function watchIdentity(videoId) {
        const watch = document.querySelector('ytd-watch-flexy[video-id]');
        return !watch || watch.getAttribute('video-id') === videoId;
    }

    function readWatch(videoId, now = Date.now()) {
        const output = result('watch');
        if (!watchIdentity(videoId)) {
            for (const field of ['views', 'publishedAt', 'durationSeconds']) output.metadataEvidence.fields[field] = { status: 'missing', reason: 'YouTube navigation has not finished updating the video.' };
            return output;
        }
        const root = document.querySelector('ytd-watch-metadata') || document.querySelector('#above-the-fold') || document;
        const identityTag = document.querySelector('meta[itemprop="videoId"]');
        const canonical = document.querySelector('link[rel="canonical"]');
        let headMatches = identityTag?.getAttribute('content') === videoId;
        try { headMatches ||= new URL(canonical?.getAttribute('href'), location.href).searchParams.get('v') === videoId; } catch {}
        const meta = field => headMatches ? [...document.querySelectorAll(`meta[itemprop="${field}"]`)]
            .map(node => ({ source: `meta[itemprop="${field}"]`, raw: node.getAttribute('content') })) : [];
        const tooltip = texts(root, selectors.watchTooltip);
        const info = texts(root, selectors.watchInfo);
        choose(output, 'views', [...meta('interactionCount'), ...tooltip, ...texts(root, selectors.watchViews), ...info],
            text => parseViews(text, /^\d+$/.test(clean(text))));
        choose(output, 'publishedAt', [...meta('datePublished'), ...meta('uploadDate'), ...tooltip, ...texts(root, selectors.watchDate), ...info], text => parsePublished(text, now));
        const isAd = Boolean(document.querySelector('#movie_player.ad-showing'));
        const media = document.querySelector('video.html5-main-video');
        choose(output, 'durationSeconds', [...meta('duration'), ...(!isAd ? texts(document, selectors.playerDuration) : [])], parseDuration);
        if (output.durationSeconds === null && !isAd && validNumber(media?.duration) && media.duration > 0) {
            output.durationSeconds = media.duration;
            output.metadataEvidence.fields.durationSeconds = { status: 'parsed', source: 'video.html5-main-video.duration', raw: String(media.duration) };
        }
        if (!isAd && media?.duration === Infinity) {
            output.durationSeconds = null;
            output.metadataEvidence.fields.durationSeconds = { status: 'not-applicable', reason: 'Live video has no fixed length.' };
        }
        return output;
    }

    function relativeUploadDate(timestamp, now) {
        const seconds = Math.floor(Math.abs(now - timestamp) / 1000);
        if (seconds === 0) return 'just now';
        const units = [[365 * 86400, 'y'], [30 * 86400, 'mo'], [7 * 86400, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']];
        const [size, suffix] = units.find(([size]) => seconds >= size);
        const amount = `${Math.floor(seconds / size)}${suffix}`;
        return timestamp > now ? `in ${amount}` : `${amount} ago`;
    }

    function summarize(item, now = Date.now()) {
        const views = validNumber(item.views) ? `${compactViews.format(item.views)} views` : 'Views unavailable';
        const date = validNumber(item.publishedAt) ? relativeUploadDate(item.publishedAt, now) : 'Upload date unavailable';
        const duration = validNumber(item.durationSeconds) ? formatDuration(item.durationSeconds) : 'Length unavailable';
        return `${views} · ${date} · ${duration}`;
    }

    function formatDuration(value) {
        const seconds = Math.floor(value);
        return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
            : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    function describePage() {
        const cards = [...document.querySelectorAll('.ytLockupViewModelHost')];
        const samples = cards.slice(0, 30).map(card => {
            try { return readCard(card, { isPlaylist: Boolean(card.querySelector('yt-collection-thumbnail-view-model')) }); }
            catch (error) { return { error: error.message }; }
        });
        const missing = Object.fromEntries(['views', 'publishedAt', 'durationSeconds'].map(field => [field,
            samples.filter(sample => ['missing', 'unrecognized'].includes(sample.metadataEvidence?.fields[field]?.status)).length]));
        const id = new URL(location.href).searchParams.get('v');
        return { selectorVersion, selectors, language: document.documentElement.lang, cardCount: cards.length,
            sampleLimit: 30, missingInCardSamples: missing, samples, watch: id && location.pathname === '/watch' ? readWatch(id) : null };
    }

    globalThis.YouTubeMetadata = { selectorVersion, selectors, parseViews, parseDuration, parsePublished, readCard, readWatch, watchIdentity, validNumber, summarize, describePage };
})();
