# SPEC — Audionook webapp

This is the product specification, derived from [`TASK.md`](./TASK.md) (the original
brief) plus decisions made while building. When the user adds or changes a
requirement, update this file.

## Product

A webapp for turning text into audiobooks and sharing them. Three views:

### Explore
- Public listing of published audiobooks, fetched from the server plugin.
- **Default sort: most listened to** (listen time is the quality signal).
  Also `Newest` and `Trending` (recent listen velocity).
- Filter by tag chips (multi-select, OR) and free-text search over title/author.
- A stats line shows total audiobooks and total community listen time.
- Content filter (see below) applies here.
- Infinite "Load more" paging, `PAGE_SIZE = 48`.
- Live: new publications arrive over the server `new` pubsub topic.

### Library
- Local, on-device (OPFS when available, kv-plugin/IndexedDB fallback). Everything
  you create or open is saved.
- **Collections**: folders that nest to any depth. Drag a book or a folder onto
  another folder (or a breadcrumb) to file it; folder cards show their book count.
  Removing a collection never deletes anything — its contents move up a level.
- **Collections are also queues**: books inside a collection are ordered, can be
  reordered (drag onto another book, or "Move up"/"Move down"), and the collection
  header has a **Play all** chip that plays the collection start-to-finish,
  advancing book after book through the same queue strip used for bookmark queues.
- **Archived**: a recoverable "tucked away" shelf, separate from deletion. Archive
  (or unarchive) from a book's ⋯ options; the Archived view is a flat list.
- Cards show a progress bar for partially-played books.
- ⋯ options per book: resume/listen, **mark as read / mark as unread** (reaching
  ≥98% auto-marks a book read; unread resets to the start),
  **add to collection**, **cover art** (choose your own image — cropped in a
  pan/zoom cropper to the card's 1.7:1 shape — generate one, or remove it;
  the image is kept **on this device** and only uploaded when the book is
  shared), narrator (per-book voice), share or publish, archive,
  remove from library (permanent). Title and author each have a pencil to rename,
  and tags can be added or removed inline.
- **Context menu**: right-click (desktop) or long-press (touch) any book card for a
  compact popup of the common actions, instead of the full options modal.
- **Per-book narrator**: a book can override the global default voice; the pencil
  beside the narrator line in its options modal (or "Narrator…" in the context
  menu) opens the picker and plays a preview.
- Toolbar: Archived toggle, **Filter** (read status + tags), New collection,
  **Backup** (export / sync), **Import**, and **Device sync**.
- No "Continue listening" card — the mini player already covers that.
- Search filters your own library (title/author/tags); while searching, matches
  are shown across all folders.

### Device sync
- Keeps one library in step across the user's **own** devices. A "Device sync"
  chip sits right of Import in the Library toolbar.
- First device mints a random secret, stores it locally and shows a link
  (`?sync=<secret>`); opening that link on another device stores the same secret
  there. A short **fingerprint** is shown so the user can confirm both devices are
  in the same group. The secret is never sent anywhere — the server only ever sees
  `SHA-256(secret)`.
- The server plugin is a **coordination layer only**: ephemeral, in-memory rooms
  with a handful of small signalling messages per session and nothing durable. It
  never carries bulk data.
- Bulk transfers go **device-to-device over WebRTC**; if that can't connect, they
  fall back to a **short-lived encrypted upload link** (upload-plugin) that the
  receiver downloads and the sender deletes.
- **Merge**: whole-record last-writer-wins ordered by a hybrid logical clock, with
  tombstones for deletions (a newer edit can resurrect). Synced: books
  (metadata + prose + cover), collections, bookmarks, positions. Local-only:
  settings, drafts, generated audio. The book currently playing never has its
  position overwritten remotely.
- **On-demand audio from a peer.** The generated audio cache is local, but it can
  be pulled from a linked device. When playback reaches a chunk that isn't cached
  on this device, the app asks connected peers for it before spending this
  device's CPU/battery synthesising it — so a book narrated once on a PC can be
  played on a low-end phone straight away. Misses are cheap (audio never goes
  through the coordination server; bulk goes device-to-device) and a peer that
  lacks the book is not asked about every chunk.
- "Stop syncing this device" unlinks locally and deletes nothing.

### Create
- Paste text, or open a file: `.txt`, `.md`, `.markdown`, `.html`, `.rtf`, `.pdf`,
  `.docx`, `.epub`, `.odt`. Heavy parsers (pdf.js, mammoth, zip.js, Readability)
  load lazily, only for the file type actually opened. You can also pull the main
  text from a URL.
- **No title field.** A provisional title comes from the first suitable line, then
  the ai-text-plugin infers a proper title from the text in the background; the
  user can rename later with the pencil next to the title.
- Narrator picker (28 voices, recommended group first) with an icon-only play
  button to preview the voice.
- Live estimate: words, segments, narration length.
- Narration-engine status strip (GPU vs CPU).
- "Create audiobook" → opens the player; playback may begin as soon as the first
  segment is ready (no waiting for the whole book).
- A muted privacy note sits below the create card: "Your audio stays on your own
  device, completely private, unless you choose to share it."
- **Reformat text** — off by default; a chip sits to the right of "Open a file…"
  and reveals a preset picker + optional custom instruction. It runs the
  pasted/opened text through the ai-text-plugin one segment at a time (small,
  contiguous word-budgeted chunks) to clean it before narration. Presets: clean
  up into audiobook style (drop page numbers, running heads, tables of contents,
  scan junk; join hard-wrapped lines), fix extraction errors only, reflow into
  clean prose, or a custom instruction. The model decides per segment whether a
  few small diffs or a full rewrite is the efficient answer. Processing is shown
  live: a card per segment with a before/after diff and a badge, a progress bar
  and ETA, and the model's streamed reply; the user can Stop, Retry a failed
  segment, then use or discard the result (applying it replaces the Create text
  and updates the saved draft). Runs sequentially — one request at a time.

### Player (full-screen)
- Chunked transcript only (no cover mode). The **active chunk is highlighted**
  (tint + accent bar); completed chunks dim; heading-like chunks get heading
  treatment.
- Text is scrollable; **tap any chunk to seek** to that point (clicking the
  scrubber also scrolls the reader there when auto-scroll is on). Auto-scroll
  follows the playhead; a deliberate scroll away pauses it and shows a
  **"Return to auto-scroll"** pill (small nudges don't count), and scrolling back
  to the active chunk resumes following.
- Header: back arrow, title + author (with an inline `…` button opening the book's
  options), and the theme + settings buttons. No share button.
- Scrubber (draggable), elapsed/total time, and a subtle "synthesised so far"
  indicator.
- Transport: speed pill, −10 s, play/pause, +30 s, settings gear. MediaSession
  integration (lock-screen controls, artwork).
- Settings: appearance (auto/light/dark/black), narrator, text size, auto-scroll,
  **sleep timer as a `<select>`** (off/15/30/45/60/90/120/180 min), content filter,
  download as MP3, clear cached audio.
- Mini player persists across views when the full-screen player is closed: cover,
  title/sub, ×10 back, play/pause, ×30 forward, thin contained progress bar; no
  close button.

## Sharing

Two deliberately different actions:

- **Share with a friend** — uploads only the text (upload-plugin) plus a tiny
  `.json` metadata file, and returns a short link
  `https://perchance.org/<name>?b=<upload-file-id>`. The `.json` extension is left
  off the link for brevity. Nothing is added to any public listing. The link
  contains everything needed to listen, and keeps working forever. `$meta.dynamic`
  reads the same `b` id server-side so the link unfurls with the book's title and
  cover art in social previews. A cover the
  user added is stored **locally** and only uploaded here, the first time the book
  is shared.
- **Publish to Explore** — uploads the text, enriches it with AI (below), uploads a
  tiny `.json` *bundle* with the display/playback fields (blurb/textUrl/coverUrl/
  voice), and submits a compact record to the server plugin (the bundle's id plus
  the numeric metadata the server searches/sorts on). The feed fetches each row's
  bundle lazily to render its card. A **local** cover is uploaded here as well —
  publishing is a share, so it's the only other moment a cover leaves the device.
  Because a published copy stays online permanently (removing the book only
  deletes the local copy), the Share dialog gates it behind a confirmation
  ("This will permanently share this audiobook to the public library… Continue?")
  before the catalogue form opens.
- **Cover art is local-first.** Choosing/painting a cover stores an image blob on
  the device (`coverLocal`); `coverUrl` stays empty and nothing is uploaded until
  one of the two share actions above runs `ensureCoverUrl`.
- **Backup** is separate from sharing: it exports your whole *local* library as a
  `.zip` (`bundle.json` + `texts/<id>.txt` + `covers/<id>.jpg`), optionally
  including archived books. Audio is never included, so the bundle is small. When
  the picker can actually be opened (the File System Access API is present **and**
  the page is not a cross-origin subframe — see `fssync.isAvailable()`), the Backup
  modal also offers **"Sync with a local folder"**, which writes that same zip into
  a chosen directory on the user's machine (the strongest backup — it survives
  clearing the site's data).

## AI enrichment (ai-text-plugin)
When a book is created without a title, the plugin names it from a sample of the
text (a provisional title from the first line shows immediately, and is replaced
unless the user has renamed it). On publish, the text is read once to propose:
title, author, a short blurb, up to **8** tags (from the fixed 256-item list)
and a cover-art prompt. Nothing is shown or editable until that enrichment has
finished. A second **moderation** call screens the submission only when the
author has edited the AI's draft — it rejects spam/trolling outright (the publish
is aborted with the reason) and returns a corrected title/author/blurb/tags,
which is applied before the record is built. An untouched draft skips that pass
entirely; when it runs, the UI doesn't announce it (just a spinner on the Publish
button). Everything is editable before publishing — the user can still change
any field after the moderation pass. Cover art can be chosen from the device
(then cropped to the card shape), or generated with the text-to-image plugin.

## Content filter / moderation

- A filter toggle (also in Settings) defaults to **on** (hide adult content); it
  can be turned off to show everything.
- **There is no user-chosen content rating** — not in the publish form, the share
  metadata, or the server record. A tampered client could always lie about one, so
  nothing trusts it.
- **View-time verification**: when the filter is on, the client asks the file host
  what each listing's `textUrl` **and** cover actually contain (upload-plugin
  `fileInfo` / `imageTags`) and hides flagged items, with a toast explaining what
  was hidden. This runs on every Explore page load (and when a deep link opens),
  after the row has hydrated so both URLs are known. Results are cached per URL
  for 30 days.
- **Submission-time AI moderation** (above) is a best-effort spam/troll screen
  only, and fails open — the view-time host check is the real gate.

## Server (Explore backend)

See `README.md` for the binary layout. Requirements:
- Ultra-compact durable state so the listing packs in the maximum number of books.
- Submission rate limiting (durable + per-connection) to stop state exhaustion.
- When full, evict the least-listened books (never FEATURED, never younger than
  1 h); evicted books remain reachable via their direct link.
- Listen time is only credited up to real elapsed time (token buckets), and plays
  are deduped, so ranking can't be trivially gamed.

## Local storage

- All local persistence goes through `src/storage.js`, which prefers **OPFS**
  (Origin Private File System) and falls back to the kv-plugin/IndexedDB on
  browsers without it. There is no migration from an older backend: the app has
  not launched, so no legacy data exists.
- At boot the app requests `navigator.storage.persist()` so the library and audio
  cache are not evicted under storage pressure.
- The synthesised-audio cache lives in the same layer, so it benefits from OPFS's
  large quota.

## Non-functional
- Responsive: designed for phone (390 px) and desktop (1440 px+); tested at both.
  Bottom tab bar on narrow screens (Create in the middle), side rail on wide
  screens (Create at the top).
- Themes: auto / light / dark / **black** (OLED night mode: pure-black flats,
  muted greys, no bright fills).
- Default route is **Create**.
- Deep links (`?b=<id>`) open a shared book directly, and get a per-book link preview (title + cover) via `$meta.dynamic`.
- Keyboard: space to play/pause, ←/→ to skip −10/+30 s, Esc closes the player.
- Playback is single-owner: exactly one `<audio>` element is ever allowed to play,
  so seeking/skipping/voice-changes can never overlap two voices; forward skips
  clamp just inside the final chunk rather than jumping to the end.
