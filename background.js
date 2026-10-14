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
};
const ADD_TO_QUEUE_MENU_ID = "yt-queue-add";

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
                files: ["services/video-previews.js", "main.js"],
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            return true;
        } catch {
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
    await Promise.allSettled(tabs.filter((tab) => isYouTubeWatchPage(tab.url))
        .map((tab) => refreshYouTubeTab(tab.id)));
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
        } catch {
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
        await addVideoToQueue(item);
    } catch {
        // The page may have closed or become unavailable after the menu click.
    }
});

// Keep the response channel open while an asynchronous command runs.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    async function respondWithResult(operation) {
        try {
            const result = await operation();
            sendResponse({ success: true, data: result });
        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
    }

    switch (message.type) {
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
