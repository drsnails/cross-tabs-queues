(() => {
    const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
    let state = { queue: [], playlists: [], activeItemId: null, activeTabId: null };
    let selectedPlaylistId = null;
    let refreshVersion = 0;
    let pendingActions = 0;

    async function request(type, payload) {
        const response = await chrome.runtime.sendMessage({ type, payload });
        if (!response?.success) throw new Error(response?.error || "Unable to complete this action");
        return response.data;
    }

    function showStatus(message, isError = false) {
        elements.status.textContent = message;
        elements.status.dataset.error = String(isError);
    }

    async function performAction(operation, successMessage) {
        pendingActions++;
        render();
        try {
            const result = await operation();
            await refresh();
            showStatus(typeof successMessage === "function" ? successMessage(result) : successMessage);
        } catch (error) {
            showStatus(error.message, true);
        } finally {
            pendingActions--;
            render();
        }
    }

    async function refresh() {
        const version = ++refreshVersion;
        const updatedState = await request("GET_POPUP_STATE");
        if (version !== refreshVersion) return;
        state = updatedState;
        render();
    }

    function showView(view) {
        const isQueue = view === "queue";
        elements["queue-panel"].hidden = !isQueue;
        elements["playlists-panel"].hidden = isQueue;
        for (const name of ["queue", "playlists"]) {
            elements[`${name}-view`].classList.toggle("selected", name === view);
            elements[`${name}-view`].setAttribute("aria-pressed", String(name === view));
        }
    }

    function createButton(label, title, onClick, disabled = false) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.setAttribute("aria-label", title);
        button.disabled = disabled || pendingActions > 0;
        button.addEventListener("click", onClick);
        return button;
    }

    function playItem(item, playlistId) {
        return performAction(() => request("PLAY_QUEUE_ITEM", {
            id: item.id,
            tabId: state.activeTabId,
            playlistId,
        }), "Opened in your active tab");
    }

    function renderItems(container, items, playlistId) {
        container.replaceChildren();
        if (!items.length) {
            const empty = document.createElement("li");
            empty.className = "empty";
            empty.textContent = playlistId ? "This playlist is empty." : "Your queue is empty. Add the current tab to get started.";
            container.appendChild(empty);
        }
        items.forEach((item, index) => {
            const row = document.createElement("li");
            row.className = "item" + (!playlistId && item.id === state.activeItemId ? " current" : "");
            const image = document.createElement("img");
            image.className = "thumbnail";
            image.src = item.thumbnail || `https://img.youtube.com/vi/${encodeURIComponent(item.id)}/mqdefault.jpg`;
            image.alt = "";
            const info = document.createElement("div");
            info.className = "item-info";
            const title = createButton(item.title, `Play ${item.title}`, () => playItem(item, playlistId));
            title.textContent = item.title;
            title.className = "item-title";
            title.title = item.title;
            const source = document.createElement("span");
            source.className = "item-source";
            source.textContent = item.channel || item.source || "YouTube";
            info.append(title, source);
            const actions = document.createElement("div");
            actions.className = "item-actions";
            function move(offset) {
                const type = playlistId ? "UPDATE_PLAYLIST" : "REORDER_QUEUE";
                const payload = { fromIndex: index, toIndex: index + offset };
                if (playlistId) payload.id = playlistId;
                performAction(() => request(type, payload), "Order updated");
            }
            actions.append(
                createButton("↑", "Move up", () => move(-1), index === 0),
                createButton("↓", "Move down", () => move(1), index === items.length - 1),
                createButton("×", `Remove ${item.title}`, () => performAction(
                    () => request(playlistId ? "UPDATE_PLAYLIST" : "REMOVE_FROM_QUEUE", playlistId
                        ? { id: playlistId, removeItemId: item.id } : { id: item.id }), "Item removed")),
            );
            row.append(image, info, actions);
            container.appendChild(row);
        });
    }

    function render() {
        const busy = pendingActions > 0;
        elements["queue-count"].textContent = `${state.queue.length} item${state.queue.length === 1 ? "" : "s"}`;
        renderItems(elements["queue-items"], state.queue);
        const currentIndex = state.queue.findIndex((item) => item.id === state.activeItemId);
        elements.previous.disabled = busy || currentIndex <= 0;
        elements.next.disabled = busy || currentIndex < 0 || currentIndex >= state.queue.length - 1;
        elements.clear.disabled = busy || !state.queue.length;
        elements["add-current"].disabled = busy || !state.canAddCurrent;
        elements["add-all"].disabled = busy;
        elements["save-form"].querySelector("button").disabled = busy;
        elements["playlist-list"].replaceChildren();
        if (!state.playlists.length) {
            const empty = document.createElement("p");
            empty.className = "empty";
            empty.textContent = "No saved playlists yet. Save your queue from the Queue tab.";
            elements["playlist-list"].appendChild(empty);
        }
        state.playlists.forEach((playlist) => {
            const card = createButton("", `View ${playlist.name}`, () => {
                selectedPlaylistId = playlist.id;
                elements["rename-name"].value = playlist.name;
                render();
            });
            card.className = "playlist-card" + (playlist.id === selectedPlaylistId ? " selected" : "");
            const name = document.createElement("span");
            name.textContent = playlist.name;
            const count = document.createElement("small");
            count.textContent = `${playlist.items.length} items`;
            card.append(name, count);
            elements["playlist-list"].appendChild(card);
        });
        const selected = state.playlists.find((playlist) => playlist.id === selectedPlaylistId);
        elements["playlist-detail"].hidden = !selected;
        if (selected) renderItems(elements["playlist-items"], selected.items, selected.id);
        for (const button of elements["playlist-detail"].querySelectorAll(".toolbar button")) button.disabled = busy;
        elements["add-current-to-playlist"].disabled = busy || !state.canAddCurrent;
    }

    elements["queue-view"].addEventListener("click", () => showView("queue"));
    elements["playlists-view"].addEventListener("click", () => showView("playlists"));
    elements["add-current"].addEventListener("click", () => performAction(() => request("ADD_CURRENT"),
        (added) => added ? "Current tab added" : "This tab is already in your queue"));
    elements["add-all"].addEventListener("click", () => performAction(() => request("QUEUE_ALL_TABS"),
        ({ added, duplicates, skipped }) => `${added} added · ${duplicates} already queued · ${skipped} unavailable or non-YouTube tabs skipped`));
    elements.clear.addEventListener("click", () => {
        if (confirm("Clear the current queue? Saved playlists will remain.")) performAction(() => request("CLEAR_QUEUE"), "Queue cleared");
    });
    for (const [name, offset] of [["previous", -1], ["next", 1]]) {
        elements[name].addEventListener("click", () => {
            const currentIndex = state.queue.findIndex((item) => item.id === state.activeItemId);
            const item = state.queue[currentIndex + offset];
            if (item) playItem(item);
        });
    }
    elements["save-form"].addEventListener("submit", (event) => {
        event.preventDefault();
        performAction(async () => {
            const playlist = await request("SAVE_PLAYLIST", { name: elements["playlist-name"].value });
            selectedPlaylistId = playlist.id;
            elements["rename-name"].value = playlist.name;
            elements["playlist-name"].value = "";
        }, "Playlist saved");
    });
    elements["rename-form"].addEventListener("submit", (event) => {
        event.preventDefault();
        performAction(() => request("UPDATE_PLAYLIST", { id: selectedPlaylistId, name: elements["rename-name"].value }), "Playlist renamed");
    });
    elements["load-playlist"].addEventListener("click", () => {
        if (state.queue.length && !confirm("Replace your current queue with this playlist?")) return;
        performAction(async () => {
            await request("LOAD_PLAYLIST", { id: selectedPlaylistId });
            showView("queue");
        }, "Playlist loaded in the queue and open YouTube video tabs");
    });
    elements["add-current-to-playlist"].addEventListener("click", () => performAction(
        () => request("ADD_CURRENT_TO_PLAYLIST", { id: selectedPlaylistId }),
        (added) => added ? "Current video saved to playlist" : "This video is already in the playlist",
    ));
    elements["overwrite-playlist"].addEventListener("click", () => {
        if (confirm("Replace the saved playlist's items with your current queue?")) {
            performAction(() => request("UPDATE_PLAYLIST", { id: selectedPlaylistId, replaceWithQueue: true }), "Playlist updated");
        }
    });
    elements["delete-playlist"].addEventListener("click", () => {
        if (confirm("Delete this saved playlist? Your current queue will remain.")) {
            performAction(() => request("DELETE_PLAYLIST", { id: selectedPlaylistId }), "Playlist deleted");
        }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && (changes.yt_queue_list || changes.saved_playlists)) {
            refresh().catch((error) => showStatus(error.message, true));
        }
    });
    refresh().catch((error) => showStatus(error.message, true));
})();
