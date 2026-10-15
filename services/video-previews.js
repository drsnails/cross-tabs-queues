// Add hover controls only to the preview structure confirmed by the supplied examples.
function createVideoPreviewControls({ getQueueItems, addVideo }) {
    const CARD_SELECTOR = ".ytLockupViewModelHost";
    const BUTTON_CLASS = "yt-queue-preview-add-button";
    const previewControls = new WeakMap();
    let floatingControl = null;
    let lastPointerPosition = null;

    function readPreviewMetadata(card) {
        // The title link remains when home-page autoplay replaces the thumbnail.
        const thumbnailLink = card.querySelector("a.ytLockupViewModelContentImage")
            || card.querySelector("a.ytLockupMetadataViewModelTitle");
        if (!thumbnailLink) return null;
        let videoUrl;
        try {
            videoUrl = new URL(thumbnailLink.getAttribute("href"), window.location.href);
        } catch {
            return null;
        }
        const videoId = videoUrl.searchParams.get("v");
        if (videoUrl.pathname !== "/watch" || !/^[\w-]{11}$/.test(videoId || "")
            || !["http:", "https:"].includes(videoUrl.protocol)
            || !(videoUrl.hostname === "youtube.com" || videoUrl.hostname.endsWith(".youtube.com"))) {
            return null;
        }

        const titleElement = card.querySelector("h3[title]");
        const titleLink = card.querySelector("a.ytLockupMetadataViewModelTitle");
        const title = titleElement?.getAttribute("title")?.trim() || titleLink?.textContent.trim();
        // Wait for metadata to arrive instead of queueing a misleading placeholder title.
        if (!title) return null;
        const metadataRow = card.querySelector(".ytContentMetadataViewModelMetadataRow");
        // Channel-page cards omit the channel and begin with a views/date row.
        const channelElement = metadataRow && !metadataRow.querySelector(".ytContentMetadataViewModelLeadingIcon")
            ? metadataRow.querySelector(".ytContentMetadataViewModelMetadataText") : null;
        const isPlaylist = Boolean(card.querySelector("yt-collection-thumbnail-view-model"));
        return {
            id: videoId,
            title: isPlaylist ? `${title} (first video)` : title,
            channel: channelElement?.textContent.trim() || "Unknown Channel",
            thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            isPlaylist,
            ...YouTubeMetadata.readCard(card, { isPlaylist }),
        };
    }

    function updateButton(card, control) {
        const metadata = readPreviewMetadata(card);
        control.metadata = metadata;
        control.button.hidden = !metadata || (control.isFloating && !control.active);
        if (!metadata) return;
        const isQueued = getQueueItems().some((item) => item.id === metadata.id);
        const stateKey = `${metadata.id}:${isQueued}:${control.pending}:${metadata.isPlaylist}`;
        if (control.button.dataset.state === stateKey) return;
        control.button.dataset.state = stateKey;
        control.button.dataset.queued = String(isQueued);
        control.button.disabled = isQueued || control.pending;
        const actionLabel = metadata.isPlaylist ? "Add first video to custom queue" : "Add to custom queue";
        const label = control.pending ? "Adding to queue…" : isQueued ? "Already in custom queue" : actionLabel;
        control.button.title = label;
        control.button.setAttribute("aria-label", label);
        control.button.setAttribute("aria-busy", String(control.pending));
        control.button.innerHTML = isQueued
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h12M4 11h8M4 16h8M18 10v10M13 15h10"/></svg>';
    }

    function positionFloatingButton() {
        if (!floatingControl) return;
        const { card, button } = floatingControl;
        if (!card.isConnected) {
            floatingControl.active = false;
            button.hidden = true;
            return;
        }
        const thumbnail = card.querySelector("a.ytLockupViewModelContentImage");
        const thumbnailRect = thumbnail?.getBoundingClientRect();
        const rect = thumbnailRect?.width && thumbnailRect.height
            ? thumbnailRect : card.getBoundingClientRect();
        button.style.left = `${rect.left + 8}px`;
        button.style.top = `${rect.top + 8}px`;
    }

    function updateFloatingVisibility(event) {
        if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
            lastPointerPosition = { x: event.clientX, y: event.clientY };
        }
        if (!floatingControl) return;
        if (window.location.pathname !== "/") {
            floatingControl.active = false;
            floatingControl.button.hidden = true;
            return;
        }
        const { card, button } = floatingControl;
        const rect = card.getBoundingClientRect();
        const isInsideCard = lastPointerPosition && lastPointerPosition.x >= rect.left
            && lastPointerPosition.x <= rect.right && lastPointerPosition.y >= rect.top
            && lastPointerPosition.y <= rect.bottom;
        floatingControl.active = Boolean(isInsideCard || button.contains(document.activeElement)
            || card.contains(document.activeElement));
        updateButton(card, floatingControl);
        positionFloatingButton();
    }

    function createControl(card, isFloating) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = BUTTON_CLASS;
        const control = { card, button, metadata: null, pending: false, isFloating, active: true };
        if (isFloating) {
            // Keep the control outside the replaced thumbnail and above the autoplay layer.
            button.classList.add("yt-queue-preview-floating");
            document.body.appendChild(button);
        } else {
            // Keep the button outside YouTube's aria-hidden thumbnail link.
            card.appendChild(button);
        }
        button.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            // YouTube can reuse a card for another video without replacing its DOM.
            updateButton(control.card, control);
            if (!control.metadata || control.pending || button.disabled) return;
            const { isPlaylist, ...metadata } = control.metadata;
            control.pending = true;
            updateButton(control.card, control);
            try {
                await addVideo(metadata);
            } finally {
                control.pending = false;
                updateButton(control.card, control);
            }
        });
        // Prevent pointer gestures from reaching the card's navigation handlers.
        button.addEventListener("pointerdown", (event) => event.stopPropagation());
        button.addEventListener("dblclick", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        return control;
    }

    function ensurePreviewButton(card) {
        const isHomePage = window.location.pathname === "/";
        if (isHomePage) {
            card = card.closest("ytd-rich-item-renderer") || card;
            if (!readPreviewMetadata(card)) return;
            card.classList.add("yt-queue-preview-card");
            if (!floatingControl) floatingControl = createControl(card, true);
            floatingControl.card = card;
            floatingControl.active = true;
            updateButton(card, floatingControl);
            positionFloatingButton();
            return;
        }
        let control = previewControls.get(card);
        if (!control || !card.contains(control.button)) {
            if (!readPreviewMetadata(card)) return;
            card.classList.add("yt-queue-preview-card");
            control = createControl(card, false);
            previewControls.set(card, control);
        }
        updateButton(card, control);
    }

    function handlePreviewInteraction(event) {
        const card = event.target?.closest?.(CARD_SELECTOR)
            || event.target?.closest?.("ytd-rich-item-renderer")?.querySelector(CARD_SELECTOR);
        if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
            lastPointerPosition = { x: event.clientX, y: event.clientY };
        }
        if (card) ensurePreviewButton(card);
        else updateFloatingVisibility(event);
    }

    function refreshButtons() {
        // Find marked cards, not just buttons: YouTube can delete an injected button.
        document.querySelectorAll(".yt-queue-preview-card").forEach((card) => {
            if (previewControls.has(card) && window.location.pathname !== "/") ensurePreviewButton(card);
        });
        if (floatingControl) {
            if (window.location.pathname !== "/") {
                floatingControl.active = false;
                floatingControl.button.hidden = true;
            } else {
                updateButton(floatingControl.card, floatingControl);
                positionFloatingButton();
            }
        }
    }

    document.addEventListener("pointerover", handlePreviewInteraction, true);
    document.addEventListener("focusin", handlePreviewInteraction, true);
    document.addEventListener("pointermove", updateFloatingVisibility, true);
    document.addEventListener("pointerout", (event) => {
        if (!event.relatedTarget && floatingControl) {
            floatingControl.active = false;
            floatingControl.button.hidden = true;
        }
    }, true);
    document.addEventListener("scroll", () => {
        updateFloatingVisibility();
        positionFloatingButton();
    }, true);
    window.addEventListener("resize", () => {
        updateFloatingVisibility();
        positionFloatingButton();
    });
    return { refreshButtons,
        describe() {
            const cards = [...document.querySelectorAll(CARD_SELECTOR)];
            return { selectorVersion: YouTubeMetadata.selectorVersion, cardSelector: CARD_SELECTOR, cardCount: cards.length,
                sampleLimit: 30, cards: cards.slice(0, 30).map(card => {
                    try { return { tag: card.localName, metadata: readPreviewMetadata(card),
                        hasThumbnailLink: Boolean(card.querySelector("a.ytLockupViewModelContentImage")),
                        hasTitleLink: Boolean(card.querySelector("a.ytLockupMetadataViewModelTitle")) }; }
                    catch (error) { return { error: error.message }; }
                }) };
        },
    };
}
