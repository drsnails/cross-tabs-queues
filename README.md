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

Use **YouTube queue** to append all videos from the built-in YouTube queue in
your current tab, including a queue in the miniplayer. Videos are added in queue
order, duplicates are ignored, and the popup reports how many videos were added
or skipped. This copies the queue without changing YouTube's queue or playback.
If no built-in queue is available, the popup shows a message; saved YouTube
playlists and recommendations are not imported.

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

## Debug reports

After reproducing a bug, keep the affected YouTube tab active, open the extension
popup, and choose **Download debug report** at the bottom. Share the downloaded
`youtube-queue-debug-….json` file when reporting the problem. Reload the extension
and refresh YouTube tabs once after installing this update so recent page actions
can be recorded.

The report includes extension/browser information, recent extension actions and
errors, queue counts and a sample of up to 50 queued videos, selector counts,
and sanitized page markup. Page capture works independently of the queue and
preview code, including when YouTube changes card names or the content script
fails. Video-link surroundings and watch metadata/native queue regions are
captured separately so they remain available if the full page reaches its size
limit. Capture limits and truncation are included in the file.

The markup retains rendered views/date/duration text and relevant page meta tags
for future debugging. This feature does not parse or save new video metadata in
queue items, and does not add sorting or filtering.

Reports are downloaded locally and never uploaded automatically. Review before
sharing: rendered video titles, links, page text, and queue samples can reveal
what you were watching. The collector omits account areas, forms, comments/live
chat, scripts/styles, unsafe attributes and URL parameters other than
`v`/`list`/`index`/`t`, and redacts recognized emails and credentials. It does not
read cookies, network headers, or arbitrary storage. This is best-effort
redaction, not a guarantee that all personal text is removed.

Recent page events last until the tab reloads, popup events until the popup closes,
and background events until the browser session ends (or until the worker stops
if session storage is unavailable). Each history keeps at most 80 events.
Outside YouTube, or if page access fails, the button still downloads the available
extension diagnostics and explains what could not be captured. Other websites'
URLs and page contents are excluded.

## Checks

Run `node --test tests/*.test.cjs` for background, popup, and sidebar regression tests.
