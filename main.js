(() => {
    if (window.__customYouTubeQueueInstance?.isActive()) return;
    window.__customYouTubeQueueInstance = {
        isActive() {
            try { chrome.runtime.getManifest(); return true; } catch { return false; }
        },
    };
    // Extension messages and persisted storage keys.
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
        EXTRACT_METADATA: "EXTRACT_METADATA",
    };
    const STORAGE_KEYS = {
        QUEUE: "yt_queue_list",
        SETTINGS: "yt_queue_settings",
    };

    const QUEUE_RECOVERY_DELAY_MS = 250;
    const MAX_QUEUE_RECOVERY_ATTEMPTS = 20;
    const QUEUE_FALLBACK_DELAY_MS = 15000;

    // State shared by the controls, sidebar, and page listeners.
    let hasLoadedQueue = false;
    let isQueueRequestPending = false;
    let queueRevision = 0;
    let renderedSidebar = null;
    let renderedQueueList = null;
    let renderedVideoId = null;
    let lastPageUrl = location.href;
    let queueItems = [];
    let draggedQueueItem = null;
    let isQueueMinimized = false;
    let queueMaintenanceTimeoutId = null;
    let queueMaintenanceDelayMs = null;
    let queueRecoveryAttempts = 0;

    const previewControls = createVideoPreviewControls({
        getQueueItems: () => queueItems,
        addVideo: addPreviewVideoToQueue,
    });

    async function addPreviewVideoToQueue(videoMetadata) {
        try {
            const response = await chrome.runtime.sendMessage({
                type: MESSAGE_TYPES.ADD_TO_QUEUE,
                payload: videoMetadata,
            });
            if (!response?.success) throw new Error(response?.error || "Error adding to queue");
            // Read the authoritative queue before marking the hover button as queued.
            const requestRevision = queueRevision;
            const queueResponse = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_QUEUE });
            if (queueResponse?.success && requestRevision === queueRevision) {
                queueRevision++;
                renderQueue(queueResponse.data || []);
            }
            showToast(response.data ? "Added to Queue" : "Already in Queue");
        } catch {
            showToast("Error adding to queue");
        }
    }

    // General helpers and current video metadata.
    function throttle(callback, delayMs) {
        let timeoutId = null;
        return function (...args) {
            if (timeoutId !== null) return;
            timeoutId = setTimeout(() => {
                timeoutId = null;
                callback.apply(this, args);
            }, delayMs);
        };
    }

    function escapeHtml(text) {
        return text
            ? text.replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;")
            : "";
    }

    function getCurrentVideoId() {
        return new URLSearchParams(window.location.search).get("v");
    }

    function getCurrentVideoMetadata() {
        const videoId = getCurrentVideoId();
        if (!videoId) return null;

        const titleElement = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
            || document.querySelector("h1.title yt-formatted-string")
            || document.querySelector("h1.ytd-video-primary-info-renderer");
        const title = titleElement
            ? titleElement.textContent.trim()
            : document.title.replace(" - YouTube", "");
        const channelElement = document.querySelector("ytd-channel-name a")
            || document.querySelector(".ytd-channel-name a")
            || document.querySelector("#owner-name a");
        const channel = channelElement ? channelElement.textContent.trim() : "Unknown Channel";

        return {
            id: videoId,
            title,
            channel,
            thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
            url: window.location.href,
        };
    }

    function showToast(message) {
        let toastElement = document.getElementById("yt-queue-toast");
        if (!toastElement) {
            toastElement = document.createElement("div");
            toastElement.id = "yt-queue-toast";
            document.body.appendChild(toastElement);
        }
        toastElement.textContent = message;
        toastElement.classList.add("show");
        setTimeout(() => toastElement.classList.remove("show"), 3000);
    }

    // Controls displayed beside YouTube's video actions.
    function createAddToQueueButton() {
        const addButton = document.createElement("button");
        addButton.id = "yt-queue-add-btn";
        addButton.className = "yt-queue-btn";

        const queueIcon = document.createElement("img");
        queueIcon.src = chrome.runtime.getURL("icons/queue.svg");
        queueIcon.alt = "Queue";
        queueIcon.style.width = "16px";
        queueIcon.style.height = "16px";
        queueIcon.style.marginRight = "6px";
        queueIcon.style.verticalAlign = "middle";
        addButton.appendChild(queueIcon);

        const buttonLabel = document.createElement("span");
        buttonLabel.id = "yt-queue-add-label";
        buttonLabel.textContent = "Add to Queue";
        addButton.appendChild(buttonLabel);

        const queuedCheckmark = document.createElement("span");
        queuedCheckmark.className = "yt-queue-added-check";
        queuedCheckmark.textContent = "✓";
        queuedCheckmark.setAttribute("aria-hidden", "true");
        addButton.appendChild(queuedCheckmark);

        addButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const videoMetadata = getCurrentVideoMetadata();
            if (!videoMetadata || !videoMetadata.id) {
                showToast("Could not get video info");
                return;
            }
            chrome.runtime.sendMessage({
                type: MESSAGE_TYPES.ADD_TO_QUEUE,
                payload: videoMetadata,
            }, (response) => {
                if (chrome.runtime.lastError || !response || !response.success) {
                    showToast("Error adding to queue");
                    return;
                }
                showToast(response.data ? "Added to Queue" : "Already in Queue");
                loadQueue();
            });
        });
        return addButton;
    }

    function createPreviousVideoButton() {
        const previousButton = document.createElement("button");
        previousButton.id = "yt-queue-prev-btn";
        previousButton.className = "yt-queue-nav-btn";
        previousButton.title = "Previous in Queue";
        previousButton.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>';
        previousButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            navigateToQueueVideo(-1);
        });
        return previousButton;
    }

    function createNextVideoButton() {
        const nextButton = document.createElement("button");
        nextButton.id = "yt-queue-next-btn";
        nextButton.className = "yt-queue-nav-btn";
        nextButton.title = "Next in Queue";
        nextButton.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
        nextButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            navigateToQueueVideo(1);
        });
        return nextButton;
    }

    function navigateToQueueVideo(indexOffset) {
        const currentVideoId = getCurrentVideoId();
        const currentIndex = queueItems.findIndex((item) => item.id === currentVideoId);
        if (currentIndex === -1) return;

        const targetIndex = currentIndex + indexOffset;
        if (targetIndex >= 0 && targetIndex < queueItems.length) {
            const targetVideo = queueItems[targetIndex];
            if (targetVideo && targetVideo.url) window.location.href = targetVideo.url;
        }
    }

    function updateAddToQueueButton(isQueued) {
        const addButton = document.getElementById("yt-queue-add-btn");
        const buttonLabel = document.getElementById("yt-queue-add-label");
        if (!addButton || !buttonLabel) return;

        const queuedState = String(isQueued);
        // Avoid repeated DOM changes from the page mutation observer.
        if (addButton.dataset.queued === queuedState) return;
        addButton.dataset.queued = queuedState;
        buttonLabel.textContent = isQueued ? "In Queue" : "Add to Queue";
        addButton.title = isQueued ? "This video is in your queue" : "Add this video to your queue";
        addButton.setAttribute("aria-label", addButton.title);
    }

    function updateQueueControlsVisibility() {
        const controlsContainer = document.getElementById("yt-queue-btn-container");
        const addButton = document.getElementById("yt-queue-add-btn");
        const previousButton = document.getElementById("yt-queue-prev-btn");
        const nextButton = document.getElementById("yt-queue-next-btn");
        if (controlsContainer) controlsContainer.style.display = "flex";
        if (addButton) addButton.style.display = "flex";

        const currentVideoId = getCurrentVideoId();
        const currentIndex = queueItems.findIndex((item) => item.id === currentVideoId);
        updateAddToQueueButton(currentIndex !== -1);
        const hasPreviousVideo = currentIndex > 0;
        const hasNextVideo = currentIndex !== -1 && currentIndex < queueItems.length - 1;
        if (previousButton) previousButton.style.display = hasPreviousVideo ? "flex" : "none";
        if (nextButton) nextButton.style.display = hasNextVideo ? "flex" : "none";
    }

    function insertQueueControls() {
        if (!window.location.pathname.includes("/watch")
            || document.getElementById("yt-queue-btn-container")) return;

        const videoActionsContainer = document.querySelector("#actions.ytd-watch-metadata #top-level-buttons-computed")
            || document.querySelector("#menu-container #top-level-buttons-computed")
            || document.querySelector("#top-level-buttons-computed");
        if (!videoActionsContainer) return;

        const controlsContainer = document.createElement("div");
        controlsContainer.id = "yt-queue-btn-container";
        controlsContainer.className = "yt-queue-btn-container";
        const previousButton = createPreviousVideoButton();
        previousButton.style.display = "none";
        controlsContainer.appendChild(previousButton);
        controlsContainer.appendChild(createAddToQueueButton());
        const nextButton = createNextVideoButton();
        nextButton.style.display = "none";
        controlsContainer.appendChild(nextButton);
        videoActionsContainer.insertBefore(controlsContainer, videoActionsContainer.firstChild);
        updateQueueControlsVisibility();
    }

    // Queue sidebar rendering and delegated clicks.
    function getQueueSidebarContainer() {
        // Use the outer column so panels above secondary-inner cannot precede us.
        return document.querySelector("#secondary")
            || document.querySelector("#secondary-inner");
    }

    function keepQueueSidebarFirst() {
        const sidebarElement = document.getElementById("yt-queue-sidebar");
        const secondaryContainer = getQueueSidebarContainer();
        if (!sidebarElement || !secondaryContainer) return;

        // Only move it when needed to avoid triggering the observer repeatedly.
        if (secondaryContainer.firstElementChild !== sidebarElement) {
            secondaryContainer.prepend(sidebarElement);
        }
    }

    function createQueueSidebar() {
        if (!window.location.pathname.includes("/watch")) return;
        if (document.getElementById("yt-queue-sidebar")) {
            keepQueueSidebarFirst();
            return;
        }

        const sidebarElement = document.createElement("div");
        sidebarElement.id = "yt-queue-sidebar";
        sidebarElement.innerHTML = `
            <div class="yt-queue-header">
                <h3>Custom Queue</h3>
                <div class="yt-queue-header-actions">
                    <button id="yt-queue-toggle" aria-controls="yt-queue-list" aria-expanded="true">Minimize</button>
                    <button id="yt-queue-clear">Clear</button>
                </div>
            </div>
            <div id="yt-queue-list" class="yt-queue-list"></div>
        `;
        const secondaryContainer = getQueueSidebarContainer();
        if (!secondaryContainer) return;

        secondaryContainer.prepend(sidebarElement);
        document.getElementById("yt-queue-toggle").addEventListener("click", () => {
            isQueueMinimized = !isQueueMinimized;
            updateQueueMinimizedState();
        });
        updateQueueMinimizedState();
        document.getElementById("yt-queue-clear").addEventListener("click", () => {
            chrome.runtime.sendMessage({ type: MESSAGE_TYPES.CLEAR_QUEUE }, consumeRuntimeError);
        });
    }

    function updateQueueMinimizedState() {
        const queueListElement = document.getElementById("yt-queue-list");
        const toggleButton = document.getElementById("yt-queue-toggle");
        if (!queueListElement || !toggleButton) return;
        queueListElement.hidden = isQueueMinimized;
        toggleButton.setAttribute("aria-expanded", String(!isQueueMinimized));
        const label = isQueueMinimized ? "Expand" : "Minimize";
        if (toggleButton.textContent !== label) toggleButton.textContent = label;
        toggleButton.title = isQueueMinimized ? "Show queue videos" : "Minimize queue";
    }

    // Reading lastError prevents unchecked errors for messages without a UI response.
    function consumeRuntimeError() {
        void chrome.runtime.lastError;
    }

    function renderQueue(updatedQueueItems) {
        renderQueueContents(updatedQueueItems);
        scheduleQueueMaintenance();
    }

    function renderQueueContents(updatedQueueItems) {
        queueItems = updatedQueueItems || [];
        hasLoadedQueue = true;
        previewControls.refreshButtons();
        updateQueueControlsVisibility();
        if (!window.location.pathname.includes("/watch")) return;
        if (!updatedQueueItems || updatedQueueItems.length === 0) {
            const sidebarElement = document.getElementById("yt-queue-sidebar");
            if (sidebarElement) sidebarElement.style.display = "none";
            return;
        }

        createQueueSidebar();
        const sidebarElement = document.getElementById("yt-queue-sidebar");
        const queueListElement = document.getElementById("yt-queue-list");
        if (sidebarElement) sidebarElement.style.display = "";
        if (!queueListElement) return;
        updateQueueMinimizedState();

        queueListElement.innerHTML = "";
        const currentVideoId = getCurrentVideoId();
        const queueFragment = document.createDocumentFragment();
        updatedQueueItems.forEach((video, index) => {
            const queueItemElement = document.createElement("div");
            const isCurrentVideo = video.id === currentVideoId;
            queueItemElement.className = "yt-queue-item" + (isCurrentVideo ? " yt-queue-item--playing" : "");
            queueItemElement.draggable = true;
            queueItemElement.dataset.index = index;
            queueItemElement.dataset.id = video.id;
            queueItemElement.dataset.url = video.url;
            const nowPlayingIndicator = isCurrentVideo
                ? '<div class="yt-queue-now-playing" title="Now Playing"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></div>'
                : "";
            queueItemElement.innerHTML = `
                <div class="yt-queue-handle">\u2630</div>
                ${nowPlayingIndicator}
                <img src="${escapeHtml(video.thumbnail || `https://img.youtube.com/vi/${encodeURIComponent(video.id)}/mqdefault.jpg`)}" class="yt-queue-thumb" alt="${escapeHtml(video.title)}" loading="lazy" />
                <div class="yt-queue-info">
                    <div class="yt-queue-title">${escapeHtml(video.title)}</div>
                    <div class="yt-queue-channel">${escapeHtml(video.channel)}</div>
                </div>
                <button class="yt-queue-remove" data-id="${escapeHtml(video.id)}" title="Remove from queue">\xD7</button>
            `;
            queueItemElement.addEventListener("dragstart", handleQueueDragStart);
            queueItemElement.addEventListener("dragover", handleQueueDragOver);
            queueItemElement.addEventListener("drop", handleQueueDrop);
            queueItemElement.addEventListener("dragenter", handleQueueDragEnter);
            queueItemElement.addEventListener("dragleave", handleQueueDragLeave);
            queueItemElement.addEventListener("dragend", handleQueueDragEnd);
            queueFragment.appendChild(queueItemElement);
        });
        queueListElement.appendChild(queueFragment);
        renderedSidebar = sidebarElement;
        renderedQueueList = queueListElement;
        renderedVideoId = currentVideoId;
        attachQueueClickHandler(queueListElement, currentVideoId);
    }

    function attachQueueClickHandler(queueListElement, currentVideoId) {
        if (queueListElement.queueClickHandler) {
            queueListElement.removeEventListener("click", queueListElement.queueClickHandler);
        }
        queueListElement.queueClickHandler = (event) => {
            const clickedElement = event.target;
            const queueItemElement = clickedElement.closest(".yt-queue-item");
            if (!queueItemElement) return;

            if (clickedElement.classList.contains("yt-queue-remove")) {
                event.stopPropagation();
                const videoId = clickedElement.dataset.id;
                chrome.runtime.sendMessage({
                    type: MESSAGE_TYPES.REMOVE_FROM_QUEUE,
                    payload: { id: videoId },
                }, consumeRuntimeError);
                return;
            }
            if (clickedElement.closest(".yt-queue-info") || clickedElement.classList.contains("yt-queue-thumb")) {
                if (queueItemElement.dataset.id === currentVideoId) return;
                const videoUrl = queueItemElement.dataset.url;
                if (videoUrl) window.location.href = videoUrl;
            }
        };
        queueListElement.addEventListener("click", queueListElement.queueClickHandler);
    }

    // Drag-and-drop reordering. These handlers use the queue item as `this`.
    function handleQueueDragStart(event) {
        draggedQueueItem = this;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", this.dataset.index);
        this.classList.add("dragging");
    }

    function handleQueueDragOver(event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        return false;
    }

    function handleQueueDragEnter() {
        this.classList.add("over");
    }

    function handleQueueDragLeave() {
        this.classList.remove("over");
    }

    function handleQueueDragEnd() {
        this.classList.remove("dragging");
        document.querySelectorAll(".yt-queue-item.over").forEach((queueItemElement) => {
            queueItemElement.classList.remove("over");
        });
    }

    function handleQueueDrop(event) {
        event.stopPropagation();
        event.preventDefault();
        if (draggedQueueItem !== this) {
            const fromIndex = parseInt(draggedQueueItem.dataset.index);
            const toIndex = parseInt(this.dataset.index);
            chrome.runtime.sendMessage({
                type: MESSAGE_TYPES.REORDER_QUEUE,
                payload: { fromIndex, toIndex },
            }, consumeRuntimeError);
        }
        this.classList.remove("over");
        if (draggedQueueItem) draggedQueueItem.classList.remove("dragging");
        return false;
    }

    // Queue loading and automatic playback of the next video.
    function loadQueue() {
        if (isQueueRequestPending) return;
        isQueueRequestPending = true;
        const requestRevision = queueRevision;
        chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_QUEUE }, (response) => {
            isQueueRequestPending = false;
            if (chrome.runtime.lastError) return;
            // Storage events take precedence over responses started before that change.
            if (requestRevision !== queueRevision) return;
            if (response && response.success) renderQueue(response.data || []);
        });
    }

    function attachVideoEndListener() {
        const videoElement = document.querySelector("video.html5-main-video");
        if (!videoElement || videoElement.dataset.ytQueueListenerAttached === "true") return;
        videoElement.addEventListener("ended", handleVideoEnded);
        videoElement.dataset.ytQueueListenerAttached = "true";
    }

    function handleVideoEnded() {
        chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.NEXT_VIDEO_REQUEST,
            payload: { currentVideoId: getCurrentVideoId() },
        }, (response) => {
            if (!chrome.runtime.lastError && response && response.success && response.data) {
                const nextVideo = response.data;
                window.location.href = nextVideo.url;
            }
        });
    }

    // YouTube navigation, DOM changes, and extension events.
    function ensureWatchPageUI() {
        if (!window.location.pathname.includes("/watch")) return;
        insertQueueControls();
        updateQueueControlsVisibility();
        attachVideoEndListener();
        if (!hasLoadedQueue) {
            loadQueue();
            return;
        }
        if (!queueItems.length) return;
        const sidebarElement = document.getElementById("yt-queue-sidebar");
        const queueListElement = document.getElementById("yt-queue-list");
        if (!sidebarElement || sidebarElement !== renderedSidebar
            || !queueListElement || queueListElement !== renderedQueueList
            || queueListElement.children.length !== queueItems.length
            || renderedVideoId !== getCurrentVideoId()) {
            renderQueue(queueItems);
        } else {
            if (sidebarElement.style.display === "none") sidebarElement.style.display = "";
            keepQueueSidebarFirst();
        }
    }

    function shouldMaintainQueueUI() {
        return !document.hidden && window.location.pathname.includes("/watch") && queueItems.length > 0;
    }

    function isQueueUIReady() {
        const sidebarElement = document.getElementById("yt-queue-sidebar");
        const queueListElement = document.getElementById("yt-queue-list");
        const videoElement = document.querySelector("video.html5-main-video");
        return Boolean(document.getElementById("yt-queue-btn-container")
            && videoElement?.dataset.ytQueueListenerAttached === "true"
            && sidebarElement && sidebarElement === renderedSidebar
            && sidebarElement.style.display !== "none"
            && queueListElement && queueListElement === renderedQueueList
            && queueListElement.children.length === queueItems.length
            && renderedVideoId === getCurrentVideoId());
    }

    function stopQueueMaintenance() {
        if (queueMaintenanceTimeoutId !== null) clearTimeout(queueMaintenanceTimeoutId);
        queueMaintenanceTimeoutId = null;
        queueMaintenanceDelayMs = null;
    }

    function scheduleQueueMaintenance() {
        if (!shouldMaintainQueueUI()) {
            stopQueueMaintenance();
            queueRecoveryAttempts = 0;
            return;
        }
        const needsRecovery = !isQueueUIReady();
        if (!needsRecovery) queueRecoveryAttempts = 0;
        const delayMs = needsRecovery && queueRecoveryAttempts < MAX_QUEUE_RECOVERY_ATTEMPTS
            ? QUEUE_RECOVERY_DELAY_MS : QUEUE_FALLBACK_DELAY_MS;
        if (queueMaintenanceTimeoutId !== null && queueMaintenanceDelayMs === delayMs) return;
        stopQueueMaintenance();
        queueMaintenanceDelayMs = delayMs;
        queueMaintenanceTimeoutId = setTimeout(() => {
            queueMaintenanceTimeoutId = null;
            queueMaintenanceDelayMs = null;
            if (!shouldMaintainQueueUI()) {
                queueRecoveryAttempts = 0;
                return;
            }
            if (!isQueueUIReady()) queueRecoveryAttempts++;
            ensureWatchPageUI();
            scheduleQueueMaintenance();
        }, delayMs);
    }

    function initializeYouTubePage() {
        queueRecoveryAttempts = 0;
        previewControls.refreshButtons();
        ensureWatchPageUI();
        scheduleQueueMaintenance();
        // Preview checkmarks need the queue on home, channel, and search pages too.
        loadQueue();
    }

    // Throttling runs even while YouTube keeps mutating the page.
    const handlePageMutations = throttle(() => {
        if (lastPageUrl !== location.href) {
            lastPageUrl = location.href;
            initializeYouTubePage();
        } else {
            previewControls.refreshButtons();
            ensureWatchPageUI();
            scheduleQueueMaintenance();
        }
    }, 100);

    const pageObserver = new MutationObserver(handlePageMutations);
    pageObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href", "title"],
        characterData: false,
    });
    window.addEventListener("yt-navigate-finish", initializeYouTubePage);
    window.addEventListener("spfdone", initializeYouTubePage);
    chrome.storage.onChanged.addListener((changes, storageArea) => {
        if (storageArea === "local" && changes[STORAGE_KEYS.QUEUE]) {
            queueRevision++;
            queueRecoveryAttempts = 0;
            renderQueue(changes[STORAGE_KEYS.QUEUE].newValue);
        }
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "PING") {
            sendResponse({ pong: true });
            return true;
        }
        if (message.type === MESSAGE_TYPES.EXTRACT_METADATA) {
            sendResponse(getCurrentVideoMetadata());
            return true;
        }
        if (message.type === MESSAGE_TYPES.QUEUE_UPDATED) {
            loadQueue();
            ensureWatchPageUI();
            scheduleQueueMaintenance();
            sendResponse({ success: true });
            return false;
        }
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            stopQueueMaintenance();
        } else {
            queueRecoveryAttempts = 0;
            previewControls.refreshButtons();
            ensureWatchPageUI();
            scheduleQueueMaintenance();
        }
    });
    initializeYouTubePage();
})();
