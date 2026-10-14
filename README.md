# YouTube Custom Queue

A Chrome extension for managing a shared YouTube queue and saved playlists.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this folder.
3. Pin **YouTube Custom Queue** to the toolbar and open its popup.
4. Reload the extension after installing an update.

## Queue

Use **Current video** to add the active YouTube video, or **All YouTube tabs** to
collect open YouTube videos. Duplicate items are ignored; other sites and browser
pages are skipped. YouTube watch, Shorts, and youtu.be links are supported.

Click a video title in either the queue or a saved playlist to play it in the active tab. Use the arrows to
reorder items or navigate between queued videos, and × to remove an item.

On YouTube watch pages, the extension displays the same shared queue above
YouTube's sidebar panels. It restores the queue if YouTube creates or replaces the
sidebar after navigation. Queue changes notify open YouTube video tabs, including
tabs that need the content script inserted. When a video ends, the next queue
item opens without removing any videos.

Queue recovery is event-driven, with 250 ms retries for up to five seconds while
UI elements are missing. A 15-second fallback runs only on visible YouTube watch
pages with an active queue. Background tabs, other YouTube pages, and empty queues
have no maintenance timer. Returning to a tab restores missing controls immediately.

Use **Minimize** in the inserted queue header
to hide the video list while keeping the header and queue intact; **Expand** shows it again.

## Preview buttons

Hover a video card to reveal the queue button at the thumbnail's top left. A green
checkmark indicates that the video is already queued. The button is also available
when keyboard focus enters the card.

This works on recommendations, home and channel pages, and other pages such as
search when they use the same `ytLockupViewModelHost` preview with a YouTube watch
link. Other preview layouts and Shorts cards are skipped. A playlist card's hover
button adds only its first linked video, explicitly labeled in the button tooltip.

## Saved playlists

Enter a name below the queue and choose **Save** to create an independent snapshot.
In **Saved playlists**, select a playlist to rename it, reorder or remove its
items, replace its contents with the current queue, or delete it.

**Load playlist** replaces the active queue and displays it in open YouTube video
tabs, including when the popup was opened from another website. It does not change
the video currently playing. **Current video** in the saved playlist panel adds the
active YouTube video directly to that playlist without changing the active queue.

The queue and saved playlists use local extension storage. Queues from the earlier
sync-storage version migrate automatically. Older non-YouTube entries are excluded
from queue and playlist views; they remain on disk until those collections are
explicitly edited. These saved playlists belong to this extension, not your
YouTube account.

## Checks

Run `node --test tests/*.test.cjs` for background, popup, and sidebar regression tests.
