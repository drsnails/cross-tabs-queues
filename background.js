importScripts("services/diagnostics.js");

// Extension messages and persisted storage keys.
const STORAGE_KEYS = {
    QUEUE: "yt_queue_list",
    PLAYLISTS: "saved_playlists",
};
const MESSAGE_TYPES = {
    ADD_TO_QUEUE: "ADD_TO_QUEUE",
    QUEUE_UPDATED: "QUEUE_UPDATED",
    GET_QUEUE: "GET_QUEUE",
    REMOVE_FROM_QUEUE: "REMOVE_FROM_QUEUE",
    CLEAR_QUEUE: "CLEAR_QUEUE",
    PLAY_VIDEO: "PLAY_VIDEO",
    REORDER_QUEUE: "REORDER_QUEUE",
    PLAY_QUEUE_ITEM: "PLAY_QUEUE_ITEM",
    NEXT_VIDEO_REQUEST: "NEXT_VIDEO_REQUEST",
    ADD_CURRENT: "ADD_CURRENT",
    QUEUE_ALL_TABS: "QUEUE_ALL_TABS",
    IMPORT_YOUTUBE_QUEUE: "IMPORT_YOUTUBE_QUEUE",
    EXTRACT_METADATA: "EXTRACT_METADATA",
    GET_POPUP_STATE: "GET_POPUP_STATE",
    GET_PLAYLISTS: "GET_PLAYLISTS",
    SAVE_PLAYLIST: "SAVE_PLAYLIST",
    UPDATE_PLAYLIST: "UPDATE_PLAYLIST",
    DELETE_PLAYLIST: "DELETE_PLAYLIST",
    LOAD_PLAYLIST: "LOAD_PLAYLIST",
    ADD_CURRENT_TO_PLAYLIST: "ADD_CURRENT_TO_PLAYLIST",
    CREATE_DIAGNOSTIC_REPORT: "CREATE_DIAGNOSTIC_REPORT",
};
const ADD_TO_QUEUE_MENU_ID = "yt-queue-add";

// Session-only history survives service worker suspension, never browser restart.
const DIAGNOSTIC_SESSION_KEY = "queue_diagnostic_events";
let diagnosticHistory = [];
let pendingDiagnosticWrite = (async () => {
    try {
        const stored = await chrome.storage.session?.get(DIAGNOSTIC_SESSION_KEY);
        if (Array.isArray(stored?.[DIAGNOSTIC_SESSION_KEY])) diagnosticHistory = QueueDiagnostics.scrub(stored[DIAGNOSTIC_SESSION_KEY]).slice(-80);
    } catch { /* Diagnostics must never prevent queue operations. */ }
})();

function recordBackgroundEvent(type, details) {
    const event = QueueDiagnostics.scrub({ at: new Date().toISOString(), type, ...details });
    pendingDiagnosticWrite = pendingDiagnosticWrite.then(async () => {
        diagnosticHistory.push(event);
        diagnosticHistory = diagnosticHistory.slice(-80);
        try { await chrome.storage.session?.set({ [DIAGNOSTIC_SESSION_KEY]: diagnosticHistory }); } catch {}
    });
}

// Serialize mutations so simultaneous requests do not overwrite each other.
let pendingQueueMutation = Promise.resolve();

function serializeQueueMutation(mutation) {
    const mutationResult = pendingQueueMutation.then(() => mutation());
    // A failed mutation must not prevent later requests from running.
    pendingQueueMutation = mutationResult.catch(() => {});
    return mutationResult;
}

// Content script messaging, including tabs opened before extension installation.
async function ensureContentScriptLoaded(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { type: "PING" });
        return true;
    } catch {
        try {
            await chrome.scripting.insertCSS({
                target: { tabId },
                files: ["styles/content.css"],
            });
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ["services/diagnostics.js", "services/video-previews.js", "main.js"],
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            return true;
        } catch (error) {
            recordBackgroundEvent("content-injection-error", { error: error.message });
            return false;
        }
    }
}

async function sendMessageToYouTubeTab(tabId, message) {
    await ensureContentScriptLoaded(tabId);
    return chrome.tabs.sendMessage(tabId, message);
}

// Queue persistence and mutations.
let queueStorageReady;

function initializeQueueStorage() {
    if (!queueStorageReady) {
        queueStorageReady = (async () => {
            const values = await chrome.storage.local.get(STORAGE_KEYS.QUEUE);
            if (values[STORAGE_KEYS.QUEUE] !== undefined) return;
            // All readers share this migration so it cannot overwrite a new mutation.
            const legacyValues = await chrome.storage.sync.get(STORAGE_KEYS.QUEUE);
            await saveQueue(legacyValues[STORAGE_KEYS.QUEUE] || []);
        })().catch((error) => {
            queueStorageReady = undefined;
            throw error;
        });
    }
    return queueStorageReady;
}

async function getQueue() {
    await initializeQueueStorage();
    const storedValues = await chrome.storage.local.get(STORAGE_KEYS.QUEUE);
    return filterYouTubeItems(storedValues[STORAGE_KEYS.QUEUE] || []);
}

async function saveQueue(queueItems) {
    await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: queueItems });
    await publishQueueToYouTubeTabs();
}

function isYouTubePage(urlString) {
    try {
        const url = new URL(urlString);
        return ["http:", "https:"].includes(url.protocol)
            && (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com"));
    } catch {
        return false;
    }
}

function isYouTubeWatchPage(urlString) {
    if (!isYouTubePage(urlString)) return false;
    const url = new URL(urlString);
    return url.pathname === "/watch" && Boolean(url.searchParams.get("v"));
}

async function refreshYouTubeTab(tabId) {
    // The content script reads the latest queue, rather than an old broadcast snapshot.
    await sendMessageToYouTubeTab(tabId, { type: MESSAGE_TYPES.QUEUE_UPDATED });
}

async function publishQueueToYouTubeTabs() {
    const tabs = await chrome.tabs.query({ url: "*://*.youtube.com/watch*" });
    const results = await Promise.allSettled(tabs.filter((tab) => isYouTubeWatchPage(tab.url))
        .map((tab) => refreshYouTubeTab(tab.id)));
    for (const result of results) {
        if (result.status === "rejected") recordBackgroundEvent("queue-broadcast-error", { error: result.reason?.message });
    }
}

// Only YouTube video links can enter the queue or saved playlists.
function normalizeQueueItem(metadata) {
    const url = new URL(metadata?.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only YouTube video tabs can be added");
    const isYouTube = url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com");
    const videoId = isYouTube
        ? url.searchParams.get("v") || url.pathname.match(/^\/shorts\/([^/]+)/)?.[1]
        : url.hostname === "youtu.be" ? url.pathname.slice(1) : null;
    if (!videoId || (isYouTube && !["/watch"].includes(url.pathname) && !url.pathname.startsWith("/shorts/"))) {
        throw new Error("Open a YouTube video tab to add it");
    }
    return {
        id: videoId,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        title: String(metadata.title || url.hostname),
        channel: String(metadata.channel || url.hostname.replace(/^www\./, "")),
        thumbnail: `https://img.youtube.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`,
        source: "youtube",
    };
}

function filterYouTubeItems(items) {
    // Keep old cross-site entries on disk until an explicit edit, but exclude them from views.
    return items.filter((item) => {
        try { normalizeQueueItem(item); return true; } catch { return false; }
    });
}

function addVideoToQueue(metadata) {
    const videoMetadata = normalizeQueueItem(metadata);
    return serializeQueueMutation(async () => {
        const queueItems = await getQueue();
        if (queueItems.some((item) => item.id === videoMetadata.id)) return false;

        const newQueueItem = { ...videoMetadata, addedAt: Date.now() };
        queueItems.push(newQueueItem);
        await saveQueue(queueItems);
        return true;
    });
}

function removeVideoFromQueue(videoId) {
    return serializeQueueMutation(async () => {
        const queueItems = await getQueue();
        const remainingItems = queueItems.filter((item) => item.id !== videoId);
        if (remainingItems.length === queueItems.length) return false;

        await saveQueue(remainingItems);
        return true;
    });
}

function clearQueue() {
    return serializeQueueMutation(async () => {
        await saveQueue([]);
        return true;
    });
}

function reorderQueue(fromIndex, toIndex) {
    return serializeQueueMutation(async () => {
        const queueItems = await getQueue();
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)
            || fromIndex < 0 || fromIndex >= queueItems.length
            || toIndex < 0 || toIndex >= queueItems.length) return false;

        const [movedItem] = queueItems.splice(fromIndex, 1);
        queueItems.splice(toIndex, 0, movedItem);
        await saveQueue(queueItems);
        return true;
    });
}

// Playback follows playlist order without changing the saved queue.
async function getNextQueuedVideo(currentVideoId) {
    await pendingQueueMutation;
    const queueItems = await getQueue();
    const currentIndex = queueItems.findIndex((item) => item.id === currentVideoId);
    if (currentIndex === -1) return null;
    return queueItems[currentIndex + 1] || null;
}

// Collect metadata from YouTube video tabs, with tab title/URL as a loading fallback.
async function getTabQueueItem(tab) {
    const fallbackItem = normalizeQueueItem({ url: tab.url, title: tab.title });
    const hostname = new URL(tab.url).hostname;
    if (fallbackItem.source === "youtube"
        && (hostname === "youtube.com" || hostname.endsWith(".youtube.com"))) {
        try {
            const metadata = await sendMessageToYouTubeTab(tab.id, { type: MESSAGE_TYPES.EXTRACT_METADATA });
            if (metadata?.id === fallbackItem.id) return normalizeQueueItem(metadata);
        } catch (error) {
            recordBackgroundEvent("metadata-fallback", { error: error.message, url: QueueDiagnostics.safeURL(tab.url) });
            // A loading or discarded tab still has a usable URL and title.
        }
    }
    return fallbackItem;
}

async function addCurrentTabToQueue() {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) throw new Error("No active tab found");
    return addVideoToQueue(await getTabQueueItem(activeTab));
}

async function queueAllOpenTabs() {
    const tabs = await chrome.tabs.query({});
    const result = { added: 0, duplicates: 0, skipped: 0 };
    for (const tab of tabs) {
        try {
            const wasAdded = await addVideoToQueue(await getTabQueueItem(tab));
            if (wasAdded) result.added++;
            else result.duplicates++;
        } catch {
            result.skipped++;
        }
    }
    return result;
}

// Runs in YouTube's MAIN world so Polymer data and the player's full queue are
// available, including items outside the rendered/expanded portion of the list.
// Keep this function self-contained: executeScript serializes it into the tab.
function extractYouTubeQueue() {
    const isQueueId = (id) => typeof id === "string" && /^(?:TQ|TLPQ)/.test(id);
    const validVideoId = (id) => typeof id === "string" && /^[\w-]{11}$/.test(id);
    const readText = (text) => typeof text === "string" ? text
        : text?.simpleText || text?.runs?.map((run) => run.text || "").join("") || "";
    const panels = [...document.querySelectorAll("ytd-playlist-panel-renderer")]
        .filter((panel) => !panel.closest("[hidden]"));
    let playerQueueId;
    let playerIds = [];
    const player = document.getElementById("movie_player");
    try {
        playerQueueId = player?.getPlaylistId?.();
        if (isQueueId(playerQueueId)) playerIds = player.getPlaylist?.() || [];
    } catch {
        // The player may still be loading; the queue panel can be read on its own.
    }
    const panel = panels.find((candidate) => {
        let id = candidate.data?.playlistId;
        if (!id) {
            const link = candidate.querySelector('a[href*="list="]');
            try { id = new URL(link?.getAttribute("href"), location.href).searchParams.get("list"); } catch {}
        }
        return isQueueId(id) && (!playerQueueId || id === playerQueueId);
    });
    if (!panel && !isQueueId(playerQueueId)) return null;

    let entries = panel?.data?.contents?.map((entry) => entry.playlistPanelVideoRenderer
        || entry.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer).filter(Boolean) || [];
    if (!entries.length && panel) {
        entries = [...panel.querySelectorAll("ytd-playlist-panel-video-renderer")].map((row) => {
            if (row.data?.videoId) return row.data;
            const link = row.querySelector('a[href*="/watch?"]');
            let videoId;
            try { videoId = new URL(link?.getAttribute("href"), location.href).searchParams.get("v"); } catch {}
            return { videoId, title: row.querySelector("#video-title")?.textContent.trim(),
                shortBylineText: row.querySelector("#byline")?.textContent.trim() };
        });
    }
    const metadata = new Map(entries.map((entry) => [entry.videoId, entry]));
    // The panel supplies titles; the player can supply IDs not yet rendered.
    const ids = Array.isArray(playerIds) && playerIds.length > entries.length
        ? playerIds : entries.map((entry) => entry.videoId);
    let skipped = 0;
    const items = [];
    for (const id of ids) {
        const entry = metadata.get(id);
        if (!validVideoId(id) || entry?.isPlayable === false) {
            skipped++;
            continue;
        }
        items.push({
            url: `https://www.youtube.com/watch?v=${id}`,
            title: readText(entry?.title) || `YouTube video (${id})`,
            channel: readText(entry?.shortBylineText || entry?.longBylineText) || "YouTube",
        });
    }
    return { items, skipped };
}

async function importYouTubeQueue() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isYouTubePage(tab?.url)) throw new Error("Open a YouTube tab to import its built-in queue");
    let extracted;
    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: "MAIN", func: extractYouTubeQueue,
        });
        extracted = result?.result;
    } catch {
        throw new Error("Unable to read this tab's YouTube queue. Reload the tab and try again");
    }
    if (!extracted || (!extracted.items?.length && !extracted.skipped)) {
        throw new Error("No built-in YouTube queue found in this tab. Add videos to YouTube's queue first");
    }
    const items = [];
    let skipped = Number.isInteger(extracted.skipped) && extracted.skipped > 0 ? extracted.skipped : 0;
    for (const metadata of extracted.items || []) {
        try { items.push(normalizeQueueItem(metadata)); } catch { skipped++; }
    }
    // Append the snapshot in one serialized write, so other tabs cannot interleave
    // changes with the imported videos or trigger a broadcast for every item.
    return serializeQueueMutation(async () => {
        const queue = await getQueue();
        const ids = new Set(queue.map((item) => item.id));
        const result = { added: 0, duplicates: 0, skipped };
        for (const item of items) {
            if (ids.has(item.id)) {
                result.duplicates++;
                continue;
            }
            ids.add(item.id);
            queue.push({ ...item, addedAt: Date.now() });
            result.added++;
        }
        if (result.added) await saveQueue(queue);
        return result;
    });
}

async function playVideoItem(itemId, tabId, playlistId) {
    await pendingQueueMutation;
    const items = playlistId
        ? (await getPlaylists()).find((playlist) => playlist.id === playlistId)?.items
        : await getQueue();
    const item = items?.find((item) => item.id === itemId);
    if (!item) throw new Error("This video is no longer in the queue or playlist");
    const { url } = normalizeQueueItem(item);
    if (Number.isInteger(tabId)) {
        try {
            await chrome.tabs.update(tabId, { url, active: true });
            return true;
        } catch {
            // Open a new tab if the original one closed while the popup was open.
        }
    }
    await chrome.tabs.create({ url });
    return true;
}

// Saved playlists are independent snapshots of the shared queue.
async function getPlaylists() {
    const values = await chrome.storage.local.get(STORAGE_KEYS.PLAYLISTS);
    return (values[STORAGE_KEYS.PLAYLISTS] || []).map((playlist) => ({
        ...playlist,
        items: filterYouTubeItems(playlist.items),
    }));
}

function validatePlaylistName(name) {
    const trimmedName = String(name || "").trim();
    if (!trimmedName) throw new Error("Enter a playlist name");
    if (trimmedName.length > 100) throw new Error("Playlist names can have up to 100 characters");
    return trimmedName;
}

function saveQueueAsPlaylist(name) {
    return serializeQueueMutation(async () => {
        const playlists = await getPlaylists();
        const playlist = {
            id: crypto.randomUUID(),
            name: validatePlaylistName(name),
            items: await getQueue(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        playlists.push(playlist);
        await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLISTS]: playlists });
        return playlist;
    });
}

function updatePlaylist(payload) {
    return serializeQueueMutation(async () => {
        const playlists = await getPlaylists();
        const playlist = playlists.find((playlist) => playlist.id === payload.id);
        if (!playlist) throw new Error("Playlist not found");
        if (payload.name !== undefined) playlist.name = validatePlaylistName(payload.name);
        if (payload.replaceWithQueue) playlist.items = await getQueue();
        if (payload.removeItemId !== undefined) {
            playlist.items = playlist.items.filter((item) => item.id !== payload.removeItemId);
        }
        if (payload.fromIndex !== undefined) {
            const { fromIndex, toIndex } = payload;
            if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)
                || fromIndex < 0 || toIndex < 0
                || fromIndex >= playlist.items.length || toIndex >= playlist.items.length) {
                throw new Error("Invalid playlist position");
            }
            const [item] = playlist.items.splice(fromIndex, 1);
            playlist.items.splice(toIndex, 0, item);
        }
        playlist.updatedAt = Date.now();
        await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLISTS]: playlists });
        return playlist;
    });
}

function deletePlaylist(playlistId) {
    return serializeQueueMutation(async () => {
        const playlists = await getPlaylists();
        await chrome.storage.local.set({
            [STORAGE_KEYS.PLAYLISTS]: playlists.filter((playlist) => playlist.id !== playlistId),
        });
        return true;
    });
}

function loadPlaylist(playlistId) {
    return serializeQueueMutation(async () => {
        const playlist = (await getPlaylists()).find((playlist) => playlist.id === playlistId);
        if (!playlist) throw new Error("Playlist not found");
        const queue = [];
        for (const item of playlist.items.map(normalizeQueueItem)) {
            if (!queue.some((existing) => existing.id === item.id)) queue.push(item);
        }
        // Saving also makes the queue visible in every open YouTube watch tab.
        await saveQueue(queue);
        return true;
    });
}

async function addCurrentTabToPlaylist(playlistId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) throw new Error("No active tab found");
    const item = await getTabQueueItem(activeTab);
    return serializeQueueMutation(async () => {
        const playlists = await getPlaylists();
        const playlist = playlists.find((playlist) => playlist.id === playlistId);
        if (!playlist) throw new Error("Playlist not found");
        if (playlist.items.some((existing) => existing.id === item.id)) return false;
        playlist.items.push({ ...item, addedAt: Date.now() });
        playlist.updatedAt = Date.now();
        await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLISTS]: playlists });
        return true;
    });
}

async function getPopupState() {
    await pendingQueueMutation;
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let activeItemId = null;
    try { activeItemId = normalizeQueueItem({ url: activeTab?.url }).id; } catch {}
    return {
        queue: await getQueue(),
        playlists: await getPlaylists(),
        activeTabId: activeTab?.id,
        activeItemId,
        canAddCurrent: activeItemId !== null,
        canImportYouTubeQueue: isYouTubePage(activeTab?.url),
    };
}

async function createDiagnosticReport() {
    const report = {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        extension: { name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version },
        environment: { userAgent: globalThis.navigator?.userAgent },
        errors: [],
        privacy: {
            note: "Contains rendered YouTube page text, video titles/links, queue samples, and recent extension actions. Review before sharing. Nothing is uploaded automatically.",
            removed: ["script/style contents", "account areas", "form contents", "comments and live chat", "event handlers and unapproved attributes", "URL parameters except v/list/index/t", "recognized emails and credential patterns"],
            collection: "Reads only queue and playlist summaries plus diagnostic session history. Does not collect cookies, network requests, headers, or arbitrary storage. Page/popup events last for their page lifetime; worker events last for this browser session (or worker lifetime if session storage is unavailable).",
        },
    };
    // Read only the relevant storage keys; exporting must not migrate or edit queues.
    try {
        let queue = (await chrome.storage.local.get(STORAGE_KEYS.QUEUE))[STORAGE_KEYS.QUEUE];
        const queueStorage = queue === undefined ? "sync (legacy)" : "local";
        if (queue === undefined) queue = (await chrome.storage.sync.get(STORAGE_KEYS.QUEUE))[STORAGE_KEYS.QUEUE];
        const playlists = (await chrome.storage.local.get(STORAGE_KEYS.PLAYLISTS))[STORAGE_KEYS.PLAYLISTS];
        report.state = QueueDiagnostics.scrub({ queueStorage, queueCount: Array.isArray(queue) ? queue.length : 0,
            queueSample: Array.isArray(queue) ? queue.slice(0, 50).map(item => ({ id: item?.id, title: item?.title, source: item?.source,
                addedAt: item?.addedAt, fieldNames: item && typeof item === "object" ? Object.keys(item) : [] })) : [],
            playlistCount: Array.isArray(playlists) ? playlists.length : 0,
            playlistSizes: Array.isArray(playlists) ? playlists.slice(0, 50).map(list => Array.isArray(list?.items) ? list.items.length : null) : [],
            sampleLimit: 50 });
    } catch (error) { report.errors.push({ stage: "queue-state", error: QueueDiagnostics.scrub(error.message) }); }
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        report.activeTab = { isYouTube: isYouTubePage(tab?.url), discarded: Boolean(tab?.discarded), status: tab?.status };
        if (report.activeTab.isYouTube) {
            report.activeTab.url = QueueDiagnostics.safeURL(tab.url);
            // Inject only the independent collector. This still works if main.js fails
            // to load, its listener breaks, or all supported card selectors go stale.
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["services/diagnostics.js"] });
            const [capture] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
                func: () => globalThis.QueueDiagnostics.capture() });
            if (!capture?.result) throw new Error("The page did not return a diagnostic snapshot");
            report.youtube = capture.result;
            // This is the same read-only extractor used for import. Retain failures
            // alongside the DOM evidence instead of letting them abort the report.
            try {
                const [native] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: extractYouTubeQueue });
                report.nativeQueue = QueueDiagnostics.scrub(native?.result ? { found: true, itemCount: native.result.items?.length,
                    skipped: native.result.skipped, sample: native.result.items?.slice(0, 30) } : { found: false });
            } catch (error) { report.errors.push({ stage: "native-queue", error: QueueDiagnostics.scrub(error.message) }); }
        } else report.youtube = { unavailable: "Open the affected YouTube tab and export again to include its page structure." };
    } catch (error) { report.errors.push({ stage: "page-capture", error: QueueDiagnostics.scrub(error.message) }); }
    await pendingDiagnosticWrite;
    report.events = [...diagnosticHistory, ...QueueDiagnostics.getEvents()]
        .sort((left, right) => left.at.localeCompare(right.at)).slice(-80);
    return report;
}

// Context menu registration and clicks.
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: ADD_TO_QUEUE_MENU_ID,
        title: "Add to Queue",
        contexts: ["page", "link"],
        documentUrlPatterns: ["*://*.youtube.com/*"],
    });
});

chrome.contextMenus.onClicked.addListener(async (menuInfo, tab) => {
    if (menuInfo.menuItemId !== ADD_TO_QUEUE_MENU_ID) return;
    try {
        const item = menuInfo.linkUrl
            ? normalizeQueueItem({ url: menuInfo.linkUrl })
            : await getTabQueueItem(tab);
        const added = await addVideoToQueue(item);
        recordBackgroundEvent("context-menu-add", { videoId: item.id, added });
    } catch (error) {
        recordBackgroundEvent("context-menu-error", { error: error.message });
        // The page may have closed or become unavailable after the menu click.
    }
});

// Keep the response channel open while an asynchronous command runs.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    async function respondWithResult(operation) {
        try {
            const result = await operation();
            if (![MESSAGE_TYPES.GET_QUEUE, MESSAGE_TYPES.GET_POPUP_STATE, MESSAGE_TYPES.GET_PLAYLISTS, MESSAGE_TYPES.CREATE_DIAGNOSTIC_REPORT].includes(message.type)) {
                recordBackgroundEvent(message.type, { success: true, result: typeof result === "boolean" ? result
                    : message.type === MESSAGE_TYPES.IMPORT_YOUTUBE_QUEUE || message.type === MESSAGE_TYPES.QUEUE_ALL_TABS ? result : undefined });
            }
            sendResponse({ success: true, data: result });
        } catch (error) {
            recordBackgroundEvent(message.type, { success: false, error: error.message });
            sendResponse({ success: false, error: error.message });
        }
    }

    switch (message.type) {
        case MESSAGE_TYPES.CREATE_DIAGNOSTIC_REPORT:
            respondWithResult(createDiagnosticReport);
            return true;
        case MESSAGE_TYPES.GET_POPUP_STATE:
            respondWithResult(getPopupState);
            return true;
        case MESSAGE_TYPES.GET_PLAYLISTS:
            respondWithResult(getPlaylists);
            return true;
        case MESSAGE_TYPES.SAVE_PLAYLIST:
            respondWithResult(() => saveQueueAsPlaylist(message.payload.name));
            return true;
        case MESSAGE_TYPES.UPDATE_PLAYLIST:
            respondWithResult(() => updatePlaylist(message.payload));
            return true;
        case MESSAGE_TYPES.DELETE_PLAYLIST:
            respondWithResult(() => deletePlaylist(message.payload.id));
            return true;
        case MESSAGE_TYPES.LOAD_PLAYLIST:
            respondWithResult(() => loadPlaylist(message.payload.id));
            return true;
        case MESSAGE_TYPES.ADD_CURRENT_TO_PLAYLIST:
            respondWithResult(() => addCurrentTabToPlaylist(message.payload.id));
            return true;
        case MESSAGE_TYPES.GET_QUEUE:
            respondWithResult(getQueue);
            return true;
        case MESSAGE_TYPES.ADD_TO_QUEUE:
            respondWithResult(() => addVideoToQueue(message.payload));
            return true;
        case MESSAGE_TYPES.REMOVE_FROM_QUEUE:
            respondWithResult(() => removeVideoFromQueue(message.payload.id));
            return true;
        case MESSAGE_TYPES.CLEAR_QUEUE:
            respondWithResult(clearQueue);
            return true;
        case MESSAGE_TYPES.REORDER_QUEUE:
            respondWithResult(() => reorderQueue(message.payload.fromIndex, message.payload.toIndex));
            return true;
        case MESSAGE_TYPES.ADD_CURRENT:
            respondWithResult(addCurrentTabToQueue);
            return true;
        case MESSAGE_TYPES.QUEUE_ALL_TABS:
            respondWithResult(queueAllOpenTabs);
            return true;
        case MESSAGE_TYPES.IMPORT_YOUTUBE_QUEUE:
            respondWithResult(importYouTubeQueue);
            return true;
        case MESSAGE_TYPES.NEXT_VIDEO_REQUEST:
            respondWithResult(() => getNextQueuedVideo(message.payload?.currentVideoId));
            return true;
        case MESSAGE_TYPES.PLAY_QUEUE_ITEM:
            respondWithResult(() => playVideoItem(message.payload.id, message.payload.tabId, message.payload.playlistId));
            return true;
    }
});

// Restore controls in already-open tabs after navigation or an extension reload.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if ((changeInfo.status === "complete" || changeInfo.url) && isYouTubeWatchPage(tab.url)) {
        refreshYouTubeTab(tabId).catch(() => {});
    }
});

chrome.runtime.onInstalled.addListener(() => {
    publishQueueToYouTubeTabs().catch(() => {});
});
