# Audionook — a perchance.org webapp

Turn any text into an audiobook, listen to it, keep a local library (with folders
and archiving), share a book with a friend, and publish it to a public **Explore**
listing. Everything that can run locally does: text-to-speech runs on the
listener's device via [kokoro-js](https://www.npmjs.com/package/kokoro-js) (ONNX
Runtime Web), so we never upload audio.

**The originating brief lives in [`TASK.md`](./TASK.md)** — read it first.

## Core design decisions (do not casually reverse these)

1. **We never upload audio.** A book is fully determined by `(text, voice)`, so
   publishing a book means uploading the *text* once (upload-plugin) and letting
   every listener regenerate the audio. Consequences:
   - uploads are tiny and cheap;
   - the server's durable state stays tiny (a fixed-size slot table, no blobs);
   - a share link keeps working **forever**, even after the server drops the book
     from the Explore listing due to space pressure. Eviction only removes the
     *listing*; the direct link (which carries `textUrl`) still works.
2. **The server is authoritative but its source is public.** `index.html`'s
   `<script type="text/x-server-plugin">` is visible to everyone. It contains no
   secrets. All moderation (rate limits, eviction, listen-time crediting) happens
   server-side so a tampered client cannot cheat it.
3. **NSFW is verified at view time from the host's own file tags — never declared
   by the uploader.** There is no user-chosen rating anywhere in the UI or the
   server record. When a listing loads (and when a share link opens), the client
   asks the file host what the `textUrl` and the cover actually contain, and hides
   anything flagged while the content filter is on. A tampered client cannot smuggle
   unsafe content past the filter by lying, because nothing is trusted.
4. **Edited submissions pass a best-effort AI moderation review.** If the author
   ships the AI's own catalogue draft untouched (`draftDirty()` is false), the
   pass is skipped entirely — the same model already wrote and tidied it. Only a
   hand-edited listing runs `share.moderateListing` (ai-text-plugin), which
   rejects spam/trolling and tidies the title/author/blurb/tags before the
   submission reaches the server. It fails OPEN on error, and is explicitly
   *not* a security boundary — only a filter for drive-by low-effort trolls.
   The check is deliberately unadvertised: no status text names it, just a
   spinner on the Publish button, so a tampering client isn't tipped off.
5. **The buggy-WebGPU lessons are load-bearing.** See the section at the bottom —
   the device self-test must be preserved.

## Visual design system

- **Dark-first palette** (`:root`), light palette under `:root[data-theme="light"]`,
  OLED black palette under `:root[data-theme="black"]` (near-pure-black surfaces,
  muted greys, amber text instead of amber fills); `app.js` `resolveTheme()`
  resolves `"auto"` and keeps the attribute in sync. Amber accent
  `--accent` with a dark `--accent-ink`; **any amber-filled button must use
  `--accent-ink` for its label** (never grey/white) so it reads at ~8:1.
- **Brand**: "Audionook". The mark is a wide **bookmark ribbon holding a damped
  sound wave** (`BRAND_RIBBON` + `BRAND_WAVE` in `util.js`, rendered by
  `brandMarkSvg`); `brandFaviconDataUrl()` is the same mark on an amber tile,
  injected as the favicon from `buildChrome()`. The boot splash carries an inline
  copy of the same two paths in `index.html`.
- **Typography**: `--font` = Inter (all UI, the brand wordmark, **and the reader
  body** — the reading pane is deliberately sans-serif for legibility);
  `--font-display` = Fraunces, used only for book covers. Reader headings use Inter.
- **Platform gotcha — button colours.** The platform injects a normalize rule
  `button:not([disabled]) { color: inherit }` (specificity 0,1,1) that overrides
  single-class colour rules. All `<button>` component colours are re-asserted with
  doubled-class selectors (`.btn.btn-primary`, …) in a clearly-marked block at the
  **end of `styles.css`** — keep colour rules for buttons there, and give disabled
  variants a higher-specificity selector (`.btn.btn-primary:disabled`).
- **Platform gotcha — search fields.** The same normalize sheet ships
  `input[type="search"] { box-sizing: content-box }` (specificity 0,1,1), which
  beats the global `* { box-sizing: border-box }`. A `width:100%` search input then
  overflows its container by its own padding + border — that's what pushed the
  Publish modal's "Filter tags…" field off the edge. `styles.css` re-asserts
  `input[type="search"] { box-sizing: border-box }`; keep that rule (or use
  `type="text"`) for any new search/text field.
- **Disabled primary buttons** read as a neutral surface + faint label (not a
  translucent amber), so they look intentionally inactive rather than muddy.
- **Pill heights match.** `.tag-btn` (Explore "All tags", Library "Filter") is
  tuned to the same 33 px box as `.chip` — `padding: 8px 14px; line-height: 1` and
  `svg { display: block }`. Don't give it a bigger padding: the Library `Filter`
  pill sits directly alongside `.chip`s in `.lib-actions`, and a taller box makes
  it stand out from the row.
- Reader: `/src/views.js` only builds the skeleton; `renderReader()` in `app.js`
  marks heading-like chunks `.chunk.heading`, and the active chunk gets an amber
  tint + inset left bar. Chunk markup shape is intentionally stable (it keys the
  audio cache); see `engine.js`.
- Icons are inline stroked SVGs (stroke ~1.75, `fill:none`); nav icon weight is
  pinned via CSS (`.nav-item svg { stroke-width }`) so the set stays consistent.

## Boot splash (first paint)

The app shell is injected after `styles.css` starts fetching, so on a cold load
the raw markup could flash unstyled ("janky on page load"). `index.html` fixes
this with a self-contained **boot cover**: an inline `<style>` (before the
external stylesheet, so it needs no network) that paints a full-viewport
`#bootCover` — brand mark + wordmark + spinner — and hides the shell
(`html:not(.boot-done) #app, … { visibility: hidden }`). The inline script right
after it defines `window.__boot` and flips `<html class="boot-done">` (then
removes the cover) only when **both** the stylesheet `load`ed and `app.js`
called `window.__boot.ready()` at the end of `boot()`; a 320 ms minimum display
avoids a blink, and an 8 s safety timeout guarantees it can never stick (the
`boot().catch` path also calls `ready()`). The cover carries `data-theme`
variants so it matches light/black themes, which `applyTheme()` sets during boot.

## Files

## UI conventions (keep these; they encode user-directed decluttering)

- **No implementation-detail copy in the UI.** Users are never told how things
  work internally — no "shared library connected" status, no "PG-13" badge in the
  header (the setting lives in Settings), no moderation/engine explanations.
  There is no "open a shared link" flow: users paste a `?b=` link into the URL
  bar (the app reads it at boot and on `popstate`).
- **Explore controls**: the sorts (Top listened / Newest / Trending) live in a
  segmented control (`.sort-seg`); tags live behind a separate **"All tags"**
  pill (`.tag-btn`) that opens a popover (`.tag-pop`) below it and reads
  "N tags" once any are selected. No long chip row.
- **Publish to Explore form**: the title/author/description/tag fields and the
  amber Publish button stay hidden/disabled until the AI catalogue pass finishes.
  While it runs, a spinner + "Generating metadata…" sits directly above the
  disabled button (no streaming-word text). Tags render as compact `.chip.sm`s
  in a scrollable cloud with a **"Filter tags…"** search box; both tag pickers
  (publish and the library tag editor's `.tag-pick-wrap`) constrain their filter
  input width so it doesn't span the modal.
- **Player dock** (`#playerScreen .np-dock`) is exactly five controls:
  speed pill (`#npRateBtn`), back 10s, play/pause, forward 30s, and a **bookmark**
  button (`#npBookmarkBtn`). Everything else (text size, auto-scroll, sleep
  timer, Clear cached audio, theme, content filter) lives behind
  the top-bar Settings button (`#settingsBtn`) → `openSettings()`. Per-book
  things live in the book's options modal (`#npOptsBtn` / the library card's ⋯):
  a pencil beside the narrator line opens the voice picker, and **Download as
  MP3** sits next to Archive. The reader's top
  bar has a back arrow, the title/author with an inline circled-`…` button
  (`#npOptsBtn` → the book's options modal, same as the library card's ⋯), and the
  same theme + settings buttons as the other views (`#npThemeBtn` → `toggleTheme`,
  `#npSettingsBtn` → `openSettings`). Keyboard: ← = −10s, → = +30s,
  space/k = play-pause.
- **Reader autoscroll**: with autoscroll on, the active chunk stays centred as
  playback advances. A *deliberate* scroll away (active chunk mostly outside the
  centre band) pauses autoscroll and shows a floating **"Return to auto-scroll"**
  pill (`#npScrollReturn`, bottom-right above the dock) — a tiny nudge does not
  count. Clicking the pill, the scrubber, or a chunk recentres. Scrolling back to
  the active chunk resumes following automatically. See `onReaderScroll` /
  `activeChunkOffset` / `scrollActiveIntoView` in `app.js`.
- **Seek targets the chunk holding up playback.** Clicking the scrubber recentres
  the reader on the chunk the player is actually waiting on (the one being
  synthesised), not the last one that finished — so the reader arrives before the
  audio starts. While the player is buffering, that chunk carries `.chunk.buffering`
  (pulsing amber left bar + dashed outline; disabled under `prefers-reduced-motion`)
  so it's visually obvious *why* audio is paused. `applyChunkStates(active, buffering)`
  owns both the active and buffering classes.
- **Reader scrolling is rAF-driven, not CSS-animated.** `.np-text` deliberately
  does **not** use `scroll-behavior: smooth` — that would make every programmatic
  `scrollTop` assignment animate natively and uncancellably. `animateReaderScroll()`
  in `app.js` does the easing with a generation token (`scrollGen`/`scrollRaf`) so a
  new scroll target cancels the old animation reliably.
- **Clicking the row that's already playing** just opens the reader (`openBook`
  returns early when `app.player.book.id` matches) instead of restarting it;
  clicking the scrubber also scrolls the reader to that point when autoscroll is on.
- **Bookmarks.** Tapping `#npBookmarkBtn` saves the current spot (chunk index +
  seconds) with a denormalised `bookTitle`/`snippet`/`sec`/`totalSec`, then shows a
  transient popup (`#bmPop`, anchored above the dock) with an optional note field
  and one-tap tag suggestions. Suggestions are frequency-ranked across the user's
  own bookmarks and topped up with the current book's tags, so the common flow is
  two taps. The popup auto-hides after ~8 s of inactivity, on outside click, or on
  Esc/close. Tapping the bookmark button again within ~2.5 s of an existing mark
  edits that mark instead of stacking duplicates. Bookmarks live in the
  `bookmarks` storage folder and ride along in library backups.
- **Library → Bookmarks shelf.** The library toolbar's Bookmarks chip
  (`setLibraryBookmarks`) opens a filtered view with a tag-filter chip row,
  "Play all" / `Play "tag"`, a **Manage** modal (rename a tag everywhere, delete a
  tag everywhere via `retagEverywhere`), and per-bookmark rows (play / note / tags /
  ⋯ menu). "Play …" starts a **bookmark queue** (`app.bmQueue`): the amber strip
  under the reader's top bar (`#npQueueBar`) shows `label · k of n · time · book`
  with prev/next/stop, and `Player.onBookEnd` → `advanceBookmarkQueue()` plays the
  set back to back (crossing books via `openBookmarkSpot`).
- **Listen counts are never shown publicly** (they still drive server-side
  ranking) so the counts can't be gamed for placement.
- **Radii**: `--r`=8px, `--r-sm`=6px, `--r-lg`=12px is the ceiling — don't
  reintroduce 16px+ rounding on content surfaces.
- **Book cards are compact shelf tiles, not posters.** A `.card` is a landscape
  (1.7:1) procedural cover (title + author drawn inside it, sized by container
  query) over a short body: a 2-line title and **one** muted meta line
  (`author · duration · tags` — no separate stats row). The library `.lib-grid`
  uses `minmax(170px, 1fr)` (≈4 per row on desktop, 2 at phone width), giving
  ~175×178px cards. Explore/search reuse the same `.card`, so keep the compact
  look consistent; `.folder-card`s are a separate, shorter single-row tile.
- **No page titles/subtitles** on Explore / Library / Create — the active nav item
  already says where you are. Library shows a breadcrumb *only* when you've
  navigated into a folder or a special shelf (Archived, Bookmarks) — it's real
  navigation then.
- **Create** keeps narration setup in one compact panel: a voice dropdown + preview
  button beside the amber "Create audiobook" button (`.create-setup`), with the
  privacy line ("Your audio stays on your own device…") sitting below it as plain
  unboxed text. There is no separate "Narrator" heading.
- **Create is the default route**, and there is no title field: a book gets a
  provisional title from its first line, then `share.generateTitle()` replaces it
  in the background (only if the user hasn't renamed it in the meantime — the
  pencil next to the title in the reader/options sets `titleSource:"user"`).
- **Themes**: auto / light / dark / **black**. Black is the OLED night mode: large
  flat regions are `#000`, surfaces are muted dark greys, and bright amber fills
  are replaced with dark-grey surfaces + amber text (no glowing buttons or bars).
- **Library organisation**: nested collections (folders) via `parentId`, a
  recoverable **Archived** shelf (never deletes), drag-and-drop of books and
  folders (drop onto a folder card or a breadcrumb), plus an **"Add to collection"**
  option and a collection options menu. Deleting a collection lifts its contents
  one level up. The verb is "Add to collection" (not "Move to") because it works
  on both Explore and Library books. **Folders render in their own `.folder-grid`
  segment above the books** — a separate, shorter grid from the book `.lib-grid`
  (which gets `.below-folders` for spacing when folders exist). Folder cards are
  compact single-row tiles (icon + name + count + hover ⋯), not the tall
  cover-style book cards.
- **Collections double as queues**: every book filed in a collection carries an
  `order`; the collection view sorts by it, its header has a **Play all** chip
  (`playCollection`) that starts a book queue, and books can be reordered by
  dragging one onto another (an insertion line shows where it lands) or via
  "Move up"/"Move down" in the context menu. Playing through a collection
  advances book-to-book (`advanceBookQueue`); the amber queue strip above the
  dock works for both bookmark queues and book queues.
- **Per-book narrator**: a book may name its own voice (`book.voice`); `bookVoice(book)`
  resolves to it, else the global default in Settings ("Default narrator").
  Change it via the pencil beside the narrator line in the book's options modal
  (the picker's close button returns you to those options), or "Narrator…" in the
  book's context menu (`openVoicePicker`).
- **Compact option rows**: shared `buildOpts(items)` renders small icon+label pills
  (`.opt`) that wrap, so an actions list no longer burns a full row per action;
  the description becomes a tooltip. Used by the book menu, collection menu,
  bookmark menu, etc.
- **Mark as read / unread**: `fresh` is a book whose playhead is at the start;
  reaching **≥98%** of the audio auto-marks it `finished` (`maybeMarkFinished`,
  called from `persistPosition`) so skipping the credits still counts as read.
  The options menu shows one action based on state: **Mark as unread**
  (`unreadMarker` icon — a page with a filled dot; resets the playhead to the very
  start, keeps the lifetime `listenSec`, clears `finished`) or **Mark as read**
  (`readMarker` — a page with a hollow dot; sets `finished` without moving the
  playhead). `bookContextMenu` mirrors this.
- **Library filters**: the toolbar's **Filter** pill (`.tag-btn` → `.lib-filter-pop`)
  filters by read status (All / Unread / Read) and by tags (union of every book's
  `tags`). `app.libraryView.readFilter` / `.tagFilter`; helpers
  `setLibraryFilter`, `toggleLibraryTag`, `clearLibraryFilters` (exposed to
  `views.js`). Read state is `book.finished || position.progress >= 0.98`
  (`isBookRead` in `views.js`).
- **Context menu**: right-click (desktop) or long-press (touch) a book card **or a
  collection tile** opens a compact popup (`openContextMenu` in `util.js`;
  `bookContextMenu` / `folderContextMenu` in `app.js`) instead of the full options
  modal; "More options…" opens the modal. The folder menu offers Open, Play all
  (when it has books), New subfolder, Rename…, Delete. On Explore books the popup
  omits the library-only rows (Archive/Rename/Remove).
- **Backup & export** lives in the library toolbar. The Backup modal leads with
  **"Sync with a local folder"** (File System Access API) when the picker can
  actually be opened here: choose a folder on the machine and the whole library is
  written there as `audionook-library.zip` — the best form of backup because it
  survives clearing site data. Below it are the classic "include archived", size
  estimate, export a `.zip`, and import one (adds, never overwrites). The sync
  module is **hidden entirely** when `fssync.isAvailable()` is false (no API, or a
  cross-origin subframe — which is how Perchance serves generators), so a policy
  restriction is never mistaken for a device fault.
- **Open a document**: the Create view accepts txt/markdown/html/rtf/pdf/docx/epub/
  odt, and a file dropped **anywhere on the Create page** is treated the same as
  "Open a file…". Heavy parsers load only when that file type is chosen.
- **Reformat text** is opt-in: a **"Reformat text" chip sits to the right of
  "Open a file…"** (before "Clear") and reveals the preset/custom bar + the live
  stage. It is off by default and its on/off state, preset and custom instruction
  ride in the Create draft. While a run is going, the normal Create controls are
  hidden behind the stage (`createReformatStage` `hideNodes`), matching the
  user's "let me watch it happen" request.
- **Unsaved draft**: the in-progress Create text and chosen narrator are persisted
  to the `drafts` storage folder (debounced on input) so a refresh doesn't lose
  work; the text is cleared once `createBook()` actually saves the audiobook (the
  voice is kept).
- **Mini player**: cover, title/sub, back-10s, play/pause, forward-30s, and a thin
  progress bar inset from the rounded corners. No close button (tap it to open the
  full player; the full player's back arrow returns to the mini player).
- **The playing book is marked on its cards.** The card whose book is loaded in
  the player gets `.card.current` (amber outline + glow); while audio is actually
  playing it also gets `.card.playing`, which turns the cover's small play badge
  into an animated 4-bar equaliser. `syncPlayingCards()` in `app.js` runs on every
  player state tick and keeps that card's `.card-progress` bar in step with real
  playback. The bar is now always built (added but `hidden` until there's
  progress) so it can be updated live without re-rendering the card. `views.js`
  `playerMark()` seeds the same classes at render time, so a freshly rendered
  library shows the right state before the first tick. Animate only while playing
  — a queued/paused book stays highlighted but its equaliser is static (the
  equaliser only replaces the play icon on a `.card.current.playing` card; a
  current-but-paused card keeps the ordinary play icon).
- **Per-book cover art is local-first.** The book's options (⋯ / the reader's
  `…`) has a **Cover art** row for library books: choose your own image (≤12 MB),
  let the text-to-image plugin paint one, **Adjust crop** a re-pick, or
  **Remove** it to return to the procedural cover. A chosen image opens the
  **cropper** (`src/crop.js`) — a fixed 1.7:1 window matching the card's cover
  slot: drag to pan, wheel/pinch/slider to zoom, then *Use image* bakes the
  visible region to a 720–1600px JPEG. The saved image is stored as a **blob on
  this device** (`store.js` `covers` folder, `book.coverLocal = true`) and **is
  NOT uploaded** — exactly like the audio. `book.coverUrl` stays empty until the
  user actually shares: the share-link flow and the publish-to-Explore flow both
  call `ensureCoverUrl(book)` (app.js), which uploads the stored blob once and
  records the URL. `covers.js` keeps a runtime map of object URLs (rebuilt each
  boot via `hydrateAll`) so cards, the mini player, and MediaSession artwork can
  show a cover synchronously; `buildServerRecord` sets `FLAG.CUSTOM_COVER` when
  `coverUrl || coverLocal`.

| File | Role |
| --- | --- |
| `main.pjs` | Static `$meta` + `$meta.dynamic` (per-share-link title/description/cover previews — see "`$meta.dynamic`") + plugin imports only (`createServerSocket`, `uploadPlugin`, `generateText`, `generateImage`, `superFetch`, `kv`). |
| `index.html` | The boot cover (inline style + splash + inline `window.__boot` script — see "Boot splash"), the server script, the app shell (top bar, nav, views, player, modals), and the module script entry point. |
| `src/engine.js` | TTS: `splitTextIntoChunks` (sentence chunker — abbreviation/acronym/initial/domain-aware, so it won't split at "Mr." "U.S." "K.I.S.S." "e.g." etc.), the worker source, `runWebgpuSelfTest()`, and the `TTSEngine` Kokoro + Paradee (Light voice) worker pools with a prioritised queue + chunk cache. Every job carries a **book token** (bumped in `setBook`), so a worker/peer result that arrives after the user has switched books is discarded rather than delivered onto the new book's matching index. Each pool is built **lazily** (`init(engine)`, first `ensureEngine(engine)`) and released again by `unload()` when idle (see "Load lazily, release when idle"). `_warm()`/`_warmOne()` resolve chunks from the local cache (and a linked peer, via `setChunkFetcher`/`getCachedChunk`/`putCachedChunk`) **without any worker** and deliver them near the playhead; a confirmed miss near the playhead is what asks for the pool. `_prefetch()`/`_prefetchOne()` fill the **whole book** into the local cache in the background (default `Infinity`, see `PREFETCH_WINDOW`) so a device can mirror a book generated elsewhere. See "Peer chunk sharing" and "Load lazily, release when idle". **Preserves the WebGPU edge cases.** |
| `src/player.js` | Streaming playback: two ping-ponged `<audio>` elements, preload-next, seek/skip/rate/voice, MediaSession, listen ticker. `_startAt` moves `currentIndex`/`offset` even when the chunk isn't synthesised yet (otherwise the later arrival is treated as a preload and playback stalls on "buffering" until pause/unpause); a 1 s unitstick watchdog restarts a paused active element as a backstop. Exposes `total` (chunk count), `chunkDuration(i)`, `totalDuration()` — the scrubber's `seekToFraction` depends on `total`, so don't remove that getter. |
| `src/net.js` | Client for the server plugin: reconnect/backoff, `list/submit/report/play/stats/get`, wire-format parse. |
| `src/share.js` | Uploads, AI catalogue metadata, cover generation, view-time NSFW check, share-link payload codec, server record builder + the listing **bundle** codec (`publishBundle`/`fetchBundle`/`applyBundle`/`ensureBundle`). |
| `src/covers.js` | Local-first cover registry: a per-page-load map of object URLs keyed by book id (`coverUrlFor`/`hasLocalCover`/`hydrate`/`hydrateAll`/`set`/`forget`). `coverUrlFor(book)` returns a remote `coverUrl` if present, else the hydrated local blob URL. Covers are only uploaded on share (see `ensureCoverUrl` in app.js). |
| `src/crop.js` | The pan/zoom cover **cropper** (`openCropper(blob, {aspect, title})` → Promise<Blob\|null>). Its own overlay stacked above the launching modal; reads the stage's *layout* box (`clientWidth/Height`, not `getBoundingClientRect`) so the modal's open-animation `scale(.98)` transform can't shrink the geometry. Bakes to JPEG q0.86, output width `clamp(720,1600,visible source width)`. |
| `src/storage.js` | The persistence **abstraction layer**. Exposes `folder(name)` (a tiny async key/value namespace) and `backend()`/`backendLabel()`. Prefers **OPFS** (real files in the origin private file system — fast, multi-GB, visible to storage management); falls back to the `kv-plugin` when `navigator.storage.getDirectory` is unavailable or the OPFS probe write fails. Records are one file each: a one-line JSON header (carrying the original key + value kind) followed by the JSON or raw bytes. There is no legacy localStorage/IndexedDB migration — the app has not launched. |
| `src/fssync.js` | "Sync with a local folder" (File System Access API). `isSupported()` (API present) and `isAvailable()` (API present **and** the picker may open here — see `pickerAllowed`; false in Perchance's cross-origin iframe). `chooseFolder()` (persists the `FileSystemDirectoryHandle` in IndexedDB `audionook-fs`), `describe()`, `syncNow()` (writes `audionook-library.zip` into the chosen folder). The Backup modal only renders the module when `isAvailable()`. |
| `src/devicesync.js` | **Device sync** — keeps one library in step across a user's own devices. Holds the pairing secret, the crypto (SHA-256 room id, HKDF `ctl`/`relay` keys, AES-GCM), the `Coordinator` (thin server-plugin signalling), the `Peer` (WebRTC DataChannel with an encrypted-upload relay fallback), the HLC LWW merge session, the **on-demand peer chunk broker** (`engine.fetchChunk` + the `chreq`/`chrs`/`chno` frames), and the exported `engine` singleton. See "Device sync". |
| `src/syncmeta.js` | Per-record revision bookkeeping for Device sync: a hybrid-logical-clock `rev` per record, tombstones for deletions, and the device id, persisted in the `sync` storage folder (`meta`/`deviceId` keys, debounced write). `markChanged`/`markDeleted` are called by `store.js` on every edit; the sync protocol calls `setRev` directly so a peer's record doesn't ping-pong. |
| `src/store.js` | Domain persistence on top of `storage.js`: settings, library (metadata), texts, playback positions, collections (folders), bookmarks, **covers** (local image blobs; only ever uploaded on share), NSFW cache, backup import/export primitives. Also `ensurePersistentStorage()` (called at boot) to request `navigator.storage.persist()` so the OPFS data isn't evicted. Picks the fresh-install default voice via `devicePerf.js` (persisted as `voiceAuto`). |
| `src/devicePerf.js` | Cheap fresh-install CPU/static probe for the default voice (cores, RAM, threaded-wasm, mobile, WebGPU presence + a JIT-hardened N=160 matmul: warmup, median-of-5, variance-gated, ~600 ms cap, fails open to Kokoro). |
| `src/config.js` | The 256-item `TAGS` list (classic + modern/anime/webnovel tags) + tag-bit helpers (a 32-byte / 256-bit mask, 64 hex chars on the wire, `MAX_TAGS_PER_BOOK = 8`), voices, server state field offsets, flags, `STATE`, `PAGE_SIZE`, `MAX_BLURB`/`MAX_TITLE`/`MAX_AUTHOR`, `SLEEP_OPTIONS`, etc. |
| `src/backup.js` | Whole-library export/import as a `.zip` via zip.js (lazily loaded). Bundle format `audionook-library` v1: `bundle.json` + `texts/<id>.txt` + `covers/<id>.jpg`. |
| `src/import.js` | Turns an uploaded document into plain text. Lazy per-format parsers: txt/md/html/rtf on the main thread, pdf.js for PDF, mammoth for .docx, zip.js for .epub/.odt. |
| `src/reformat.js` | AI text cleanup for Create's "Reformat text": presets, segmentation, the edit-protocol prompt/parser, the line diff, seam-joining, and the sequential `Reformatter` runner. DOM-free (the app supplies the streaming callbacks). See "Reformat text". |
| `src/ui.js` | Presentational builders: procedural cover art, book/folder cards, chips, empty states, spinners. |
| `src/views.js` | The three views: Explore, Library (folders / archived / Bookmarks shelf / drag-drop), Create. |
| `src/app.js` | The hub: boot, routing, engine/player wiring, library ops, bookmarks + playback queues, share/publish/settings/backup modals, deep links, keyboard shortcuts. |
| `src/styles.css` | Design system + all component styles. |

## Device sync

Keep one library in step across a user's **own** devices. The entry point is the
**"Device sync"** chip in the Library toolbar, immediately right of Import
(`openDeviceSyncModal` in `app.js`; core in `src/devicesync.js`). Until it has
been opened once it carries a subtle glow-and-sparkle nudge to draw the eye
(`.chip.nudge` in `styles.css`; cleared and persisted via the `deviceSyncSeen`
setting on the first click).

Design constraints (the user's): the server plugin must never be a bulk data
layer — it has to scale to millions of users, so it is only a **coordination
layer** (a few small messages per session); large transfers go device-to-device
(WebRTC) or through short-lived encrypted upload links.

- **Pairing / the secret.** First device mints a 32-byte random secret, stores it
  in the `sync` storage folder (`identity` key) and offers a link
  `https://perchance.org/<name>?sync=<base64url(secret)>`. Opening that link on
  another device (or pasting it into the modal) stores the same secret there — the
  *only* thing that ever leaves one device to establish a group. The server never
  sees the secret: the client derives the **room id** = `SHA-256(secret)` and only
  ever sends that, so the server can route without being able to join or eavesdrop.
  The modal shows a short **verification fingerprint** (the grouped, upper-cased
  head of the room hash) that must read the same on every device. The link is read
  from `?sync=` at boot (`setupSyncInvite`) and stripped from the URL with
  `history.replaceState` after a confirm prompt.
- **Coordinator (server plugin).** `sync_join(roomId US deviceId US name)`,
  `sync_send(roomId US toDevice US payload)` (relayed verbatim as a `msg` frame),
  `sync_leave(roomId)`, plus `ev` join/leave events. Rooms are **ephemeral
  in-memory Maps** — the server stores **nothing** durable, and the block never
  touches the 50 MiB Explore `state`. It is hard-capped (`SYNC_MAX_MEMBERS`,
  `SYNC_MAX_ROOMS`, `SYNC_MAX_PER_DEVICE`, `SYNC_MAX_PAYLOAD` ≈ 24 KB) and
  rate-limited per connection. A device only connects while something needs it —
  the sync modal, a running session, an in-flight chunk fetch, or optional
  background **presence** while a linked tab is visible — so idle users cost the
  server nothing. `deviceId` must match `^[0-9a-f]{6,32}$` and `roomId`
  `^[0-9a-f]{32,64}$`.
- **Bulk transfer — WebRTC first, relay as fallback.** Control frames are tiny
  (encrypted with the `ctl` key, so the server can't read even those). Once two
  peers see each other, the peer with the smaller device id initiates a
  `RTCPeerConnection` (Google STUN) and the session's records flow over a
  DataChannel (16 KB chunks, 512 KB backpressure). If WebRTC can't connect within
  8 s (or is unavailable — e.g. `RTCPeerConnection === undefined`), it falls back
  to the **relay**: the whole payload is AES-GCM encrypted with the `relay` key and
  uploaded as a short-lived (`expires: 1 h`) `text/plain` blob via upload-plugin;
  the URL is sent in a control frame, downloaded and deleted (via its
  `deletionUrl`) by the receiver.
- **Merge policy — per-record last-writer-wins with tombstones.** Every mutable
  record carries a **hybrid logical clock** revision (`<clockBase36>-<deviceId>`,
  `src/syncmeta.js`). At the start of a session each side sends a **manifest**
  (type, id, rev, signature + content hashes); each asks only for the records
  where the peer's rev wins or a hash differs, so an unchanged record costs nothing
  over the wire. Deletions are **tombstones** (kept in `syncmeta`, never
  resurrected by an older record); a live record with a *newer* rev beats a
  tombstone, so an edit can intentionally resurrect something deleted elsewhere.
  Exact rev ties break on the record signature (a tombstone's is `""`, so the live
  record wins). Whole-record LWW, not field-level — simple and unsurprising.
- **Scope.** Synced: book metadata + prose + cover, collections (folders),
  bookmarks, playback positions. **Kept local to each device**: settings, drafts,
  and the generated audio cache. The audio cache is never part of a sync session
  (it is fully regenerable from `(text, voice)`), but it *can* be pulled from a
  peer on demand — see "Peer chunk sharing". A position is never applied for the
  book playing on the device right now (`setNowPlaying`), so live progress wins the
  next time it saves.
- **Peer chunk sharing (on-demand audio).** The generated audio cache stays local
  as a *store*, but it can flow between linked devices on demand. When the TTS
  engine reaches a chunk that isn't cached here, it asks
  `engine.fetchChunk(cacheKey)` (wired in `app.js`) before spending this device's
  CPU/battery synthesising it. `src/devicesync.js` batches the keys (~30 ms, ≤ 12)
  and sends one `chreq` control frame to every connected peer; a peer answers from
  its own cache with a single bulk `chrs` frame (hits only) or a tiny `chno`. The
  requester takes the first copy per key and falls back to synthesis on a miss.
  This is what makes the low-end-device case work: generate a book once on a PC,
  open it on a phone, and the phone streams the PC's audio instead of re-narrating
  it. Two details keep it civil: a **miss streak** (24 unanswered keys) buys a
  60 s backoff so a peer that doesn't have the book isn't asked per chunk, and
  audio never touches the coordination server (bulk goes over the DataChannel, or
  the encrypted upload relay when WebRTC is unavailable). `TTSEngine._warm()`
  also pulls cached/peer audio in independently of the worker pool, so a book can
  start streaming while the voice model is still loading — and, when no pool is
  resident, it is what serves an already-narrated book outright: only a confirmed
  miss near the playhead brings the pool up (see "Load lazily, release when idle").
  Because the warm window is small, a second pass — `TTSEngine._prefetch()`,
  reaching **the whole book** by default (`PREFETCH_WINDOW` / `setPrefetchWindow`)
  — mirrors every chunk into the receiving device's local cache in the
  background, so the peer only has to stay online for the sync, not for the whole
  listen. It re-arms whenever a peer appears.
- **UX.** "Sync now" starts a fresh session (leader) or asks the current one to
  run again (non-leader); a session auto-starts shortly after a peer appears.
  "Stop syncing this device" unlinks locally only — nothing is deleted anywhere.
- **Status/limits.** This is inherently a two-device feature; the in-editor server
  emulator is one-tab, so `src/devicesync.js` is tested with **two engines in one
  page** over a fake IO adapter (`createEngine({io})`) — that path exercises the
  real coordination socket and a real WebRTC DataChannel, and the relay fallback is
  tested by stubbing `RTCPeerConnection` out. The peer chunk broker is verified the
  same way: a 4 KB chunk fetched over the DataChannel arrived byte-for-byte, a key
  the peer lacks resolves `null` (fast, via `chno`), a burst coalesces into one
  request, and the all-relay path returned four differently-sized chunks intact.
  `TTSEngine._warm()` is unit-tested with a stub worker: peer-held chunks are
  delivered exactly once with no worker, and the rest still synthesise.



A document is cleaned *before* narration by `src/reformat.js`. It is deliberately
**not** a "send the whole book to the model" design — the ai-text-plugin only
emits roughly a thousand output tokens per call, so the pipeline is built around
small segments and minimal replies.

- **Segmenting** (`planSegments`): the document is split on line boundaries into
  contiguous, non-overlapping segments of ≤360 words. Boundaries prefer paragraph
  gaps, and an oversized paragraph is cut at a line that ends a sentence (within a
  small tolerance) so a sentence is rarely sliced across segments. Short
  paragraphs are packed together so segments stay full. `maxWords` is kept low
  *because of the output budget* — a segment whose every line must be rewritten
  has to fit in one reply.
- **Prompt** (`buildSegmentPrompt`): a static system prefix (rules + two worked
  examples) + the run's TASK + the numbered segment. The prefix and task are
  identical across a run, so the plugin's KV-prefix cache keeps them hot; only the
  final segment varies. The model replies with **EDIT lines only** — `12| text`
  replaces a line, `12|` deletes it, `12-14| text` replaces a range, `12> text`
  inserts, `NONE` means no change. Any line not mentioned is copied through, so a
  clean segment costs almost nothing. A rewrite is just one big range edit, which
  is why **the model chooses diffs vs. a full rewrite per segment** rather than the
  caller deciding: both arrive through the same protocol, and the prompt tells it
  to use large range edits when most of the segment changes.
- **Hard-won prompt rules** (don't undo these): lead with "ONLY MENTION THE LINES
  THAT CHANGE … never repeat an unchanged line" or the model echoes the whole
  segment; name Project Gutenberg/ebook licence blocks and say a run of title-only
  lines (a front TOC) is deletable even without the words "Table of Contents";
  say deletion = *nothing after the bar* (the model likes to write
  `1-79| delete lines 1 to 79`, which `looksLikeDeleteCommand` also catches);
  and say to cut header/footer words glued onto a line rather than deleting the
  line.
- **Parsing** (`parseSegmentResponse`) tolerates fences, a preamble, wrapped
  rewrite lines, out-of-range/clamped line numbers, and a reply that ignores the
  protocol and just writes the new text (accepted as a full rewrite when its length
  is a plausible replacement for the segment).
- **Seam joining** (`mergeContinuations`): a segment boundary can split one
  sentence — e.g. a PDF page break with a page number between the halves, which no
  single segment can see. After a segment, and again over the whole result, a line
  that lacks sentence-ending punctuation is joined with a following lowercase-
  starting line (blank lines don't block the join); hyphen and dash joins are
  handled. The UI reports these as "mended N split line(s)".
- **Runner** (`Reformatter`): strictly sequential, one request in flight, with
  `onStart`/`onSegmentStart`/`onSegmentDelta`/`onSegmentEnd`/`onFinish` hooks and
  `stop()`. `src/app.js` wires those to `root.generateText` and the live stage;
  `src/views.js` `createReformatStage` renders a card per segment with the
  condensed line diff, a badge, the streamed raw reply (behind a disclosure), a
  progress bar + ETA, and Stop / Retry / Use / Discard. Applying recomputes the
  working text through `mergeContinuations` and writes it back to Create (and the
  draft).

**Tested end to end** against the OCR sample, Gutenberg's *Alice* (.txt) and
*Pride & Prejudice* (.epub), a synthetic scanned PDF (hard wraps + page numbers +
running heads, where page-break-split sentences were rejoined), and a
German→English translation. Raw per-run model output was dumped under
`scratch/reformat-tests/` during development (ephemeral).

## Client data flow

- **Create** (`app.createBook`) → chunk text → open the player → engine synthesises
  the focused chunk first so playback can start after the *first* chunk while the
  rest build in the background. Chunks are cached in the `chunkCache` storage
  folder keyed by `v2:mp3:<voice>:<chunk-json>`, so replaying the same text is
  instant.
- **Save** is automatic: books live in the `library` storage folder (metadata) +
  `texts` (prose) + `positions` (playhead), all served by `src/storage.js` (OPFS
  by default, kv-plugin as a fallback).
- **Share with a friend** → upload text, then upload a tiny `.json` metadata file
  (title/author/blurb/textUrl/coverUrl/voice/tagBits/wordCount) and
  build a short link: `https://perchance.org/<name>?b=<upload-file-id>`. The id is
  the upload-plugin filename's stem (e.g. `abcd…` for `abcd….json`), so `?b=` stays
  short. The `.json` extension is omitted from the link for brevity and re-added
  when resolving; `src/app.js` `setupDeepLink()` → `share.resolveSharePayload`
  fetches `user.uploads.dev/file/<id>.json`. If the book has a **local** cover,
  this is where it's uploaded (`ensureCoverUrl`) — nothing is uploaded merely by
  adding a cover. Because the id is a *query parameter*, `$meta.dynamic` in
  `main.pjs` can read it server-side and give the link a per-book title, blurb
  and cover image when it's unfurled in a chat/social preview (see below).
- **Publish to Explore** → upload text → ask the ai-text-plugin for title/author/
  blurb/tags/cover-prompt → (cover uploaded by the user, or AI-generated) →
  run `share.moderateListing` only if the author edited the AI draft (AI
  spam/troll screen + a final tidy of title/author/blurb/tags, fail-open, silent
  — just a spinner on the button) → upload a tiny `.json` *bundle* holding
  the display/playback fields (title/author/blurb/textUrl/coverUrl/voice), then
  server `submit` with the bundle's id plus the numeric metadata (up to **8**
  tags, as a 64-hex bitmask). The server stores a 272-byte slot and returns a
  `seq`. The feed then lazily fetches each row's bundle to render its cover/blurb
  (`share.fetchBundle` → `share.applyBundle`). A locally-stored cover is uploaded
  here too (publishing is a share).

## `$meta.dynamic` (shared-link previews)

`main.pjs` defines `$meta.dynamic(inputs)`, which makes a `?b=<id>` link unfurl
with the right title, description and cover image in social/chat previews. It
reads only `inputs.urlParams.b`, validates it (`^[A-Za-z0-9_-]{1,80}$`), then
fetches the same tiny share-meta JSON the client resolves and returns
`{ title, description, image }`. It must stay **fully self-contained** — the
platform extracts the source and runs it in an isolated server sandbox with no
generator scope (`fetch`/`AbortSignal`/JSON are available; `root`, lists,
imports and DOM are not). Any invalid input, missing `b`, failed fetch, or
malformed JSON returns `{}`, which falls back to the static `$meta`
title/description. Server-side caching means the output must be deterministic
for a given `b`. Verify with
`https://perchance.org/api/getDynamicMetaData?__generatorName=<name>&b=<id>`
(after saving — the endpoint serves the deployed version).

## Server state layout (the thing to get right)

`state` is the 50 MiB durable `Uint8Array`. Layout (v3) — **must stay in sync with
`STATE`/`MAXLEN`/`FLAG` in `src/config.js`**:

```
header (32 B): u8 version | u8 flags | u16 pad | u32 bookCount | u32 nextSeq
               u32 slotCount | u32 ringHead | u32 totalListenSec
               u32 submissions | u32 evictions
ring (512 x 8 B): {u32 netHash, u32 timeSec}   durable submission rate limiter
slots: SLOT = 272 B each, count = floor((state.length - REGION_START) / SLOT)
```

A slot holds: `seq, listenSec, plays, wordCount, created, hashA, hashB, flags,
tagBits(32 B = a 256-bit tag mask), length bytes, lastListen, bundleId(44),
title(112), author(40)` — strings are UTF-8, length-prefixed, no JSON. At 50 MiB
that is ~180 000 books. `STATE_VERSION` is 3; a version mismatch wipes state (the
app has not launched, so no legacy migration is needed).

A slot deliberately stores ONLY the numeric metadata the server searches/sorts on,
plus `title`/`author` (needed for the text query). Everything bulky that the feed
only needs to *display* or *play* — blurb, `textUrl`, `coverUrl`, voice — lives in
a small uploaded `.json` bundle (immutable, CDN-cached on `user.uploads.dev`), and
the slot keeps just the bundle's 32-hex upload id. The client hydrates listing
rows a few at a time (`src/app.js` `hydrateExplore()`), swapping each card in
place as its bundle arrives; `share.ensureBundle()` covers the case where a card
is opened before hydration finished.

- **Ranking** is a lazy in-memory order cached per sort (`top` = listenSec,
  `new` = createdAt, `trending` = listenSec decayed by recency). Orders rebuild on
  demand, throttled to at most once per 1.5 s, and are invalidated on any mutation.
- **Listing** is early-exit for the common unfiltered browse (O(offset+limit));
  tag-mask (any-of) / text query filters scan in rank order.
- **Eviction**: when full, drop the lowest-`listenSec` slot (skipping FEATURED
  books and anything younger than `EVICT_GRACE_SEC` = 1 h). The evicted book's
  link still works — only the listing entry disappears.
- **Rate limits**: durable submission ring (4/h, 15/day per `conn.net[3]`; 2/6 for
  proxies) plus a per-connection token bucket; listen-time crediting is limited by
  per-connection + `net[3]` + `net[2]` token buckets (in-memory is fine here);
  plays are deduped per connection+book for 10 minutes.
- **Wire format**: fields joined by `U+001F`, rows by `U+001E`. RPCs: `list`,
  `get`, `submit`, `report`, `play`, `stats`.

## Testing the server

While `window.generatorIsUnsaved` is true the server-plugin runs a one-tab
emulator whose durable state **resets on every `page_refresh`**. To test against
the real server, save the generator first.

## WebGPU correctness self-test (important — do not remove)

Some GPUs/drivers silently miscompile WebGPU compute shaders: nothing throws, the
shader just returns wrong numbers, which surfaces as garbage audio. Before
committing to the (much faster) GPU path, `runWebgpuSelfTest()` in
`src/engine.js` runs at module top level, before any worker is created. It loads a
few small kernels from Hugging Face's
[`@huggingface/kernels`](https://huggingface.co/blog/webgpu-kernels) collection and
compares their output against a JS CPU reference. Any numeric mismatch (beyond
`WEBGPU_SELFTEST_ATOL + WEBGPU_SELFTEST_RTOL*|expected|`) fails the device, and
`createWorker` then sets `allowWebGpu = false` so the worker falls back to wasm.
The UI shows `device: wasm (WebGPU failed correctness check)` and refuses to
re-select the GPU path.

Probes cover the ops kokoro leans on and that HF's Fleet GPU-trial suite most often
reports failing on real devices (Adreno/mobile GPUs especially): MatMul (incl.
batched + large-K), LayerNormalization, Transpose, Log. All f32 (kokoro uses
`dtype:"q8"` on wasm; f16 is avoided because the adapter may lack `shader-f16`).

When a WebGPU adapter exists, the result is exposed at
`window.webgpuSelfTestResult` for diagnostics
(`{passed, skipped, results:[{name, mismatches, maxAbs, error}]}`); on a device
with no WebGPU at all the test is skipped and the variable is left unset. A thrown error
is treated as "skip" (not a failure) so network/unsupported-feature errors don't
cause false fallbacks — only a numerically wrong result fails the device.

To exercise the fallback path on a healthy GPU, temporarily make
`runWebgpuSelfTest()` return `{passed:false, skipped:false, results:[], failed:[]}`
and confirm the device indicator switches to wasm.

## wasm speedup — many small ORT sessions beat one big one

The backup (wasm) inference path was ~2.4x faster than the original single-pool
design after two changes, with **zero quality loss** (same model, same `q8`
weights). Measured on a 64-core / 32 GB machine, `af_heart`, 48 × ~290-char
chunks, audio-per-wall-second:

| pool | audio/sec | speedup |
| --- | --- | --- |
| 4 × nt=4 (old default) | 3.85 | 1.0x |
| 16 × nt=2 | 8.66 | 2.25x |
| 16 × nt=4 | 8.82 | 2.29x |
| **1 × nt=4 + 15 × nt=2** | **9.08** | **2.36x** |

End-to-end through the real app engine (incl. WAV→MP3 and the pipeline tail) the
same change takes 48 chunks from ~3.6 to ~7-8 audio/sec. The trade-off is a
slightly longer time-to-first-chunk (~24 s vs ~19 s on this machine) because the
model must load into more workers — acceptable since playback starts as soon as
the first chunk lands and the rest stream in.

### 1. Make ORT's wasm thread count reachable

`kokoro-js` is imported with `?target=es2022` and **no `?bundle`**. With
`?bundle`, esm.sh inlines `@huggingface/transformers` inside an IIFE closure, so
its `env.backends.onnx.wasm.numThreads` is unreachable and every session silently
used ORT's default `min(4, hw/2)` — which starves a 64-core box and oversubscribes
a small one. Without `?bundle`, kokoro-js and our own
`import { env } from '@huggingface/transformers'` resolve to the *same* module
instance (`transformersEnvUrl`), so `workerCode` can set the per-worker thread
count before `from_pretrained`. **Do not re-add `?bundle`.**

### 2. A pool of many small sessions

ORT's threaded wasm has a large serial fraction, so N sessions of 2 threads
out-throughput a few sessions of 4+ threads; throughput plateaus at ~24-34
threads (memory-bandwidth bound) — past that, extra workers only add RAM
(~0.28 GB each). **Hard rule: TTS + MP3 workers combined never exceed half of
`navigator.hardwareConcurrency`** (`cpuBudget` in `src/audio.js`, drawn from
first by `computeMp3PoolSize`, the rest by `threadBudget` in `src/engine.js`):
the engine runs in a browser tab the user is actively using (or beside a game),
so half the cores always stay free (the 34-thread bandwidth plateau means this
costs nothing on big machines; a 4-core phone runs 1 TTS + 1 MP3 worker).
`computePool(cores,
threading)` encodes the rest of the policy: worker 0 is a **focus** worker
(4 threads, clamped to the budget) that takes the chunk nearest the playhead
first (see `_nextIndex`), and the rest are bulk workers (2 threads when
`cores >= 16`, else 1). Always spawn worker 0 first and let the bulk workers hit
the populated `transformers-cache` Cache API, else every worker re-downloads the
model. When `SharedArrayBuffer` is unavailable the sessions are single-threaded,
so the pool uses nt=1 and one worker per thread (also within the half budget).

Re-verification tip: `splitTextIntoChunks` + `TTSEngine.setBook`/`setFocus` on
unique text (so the chunk cache misses), then measure decoded audio seconds over
wall time. Load the page first, wait for `__app.engine.ready`, and confirm
`engine.workers.map(w => w.numThreads)` matches `computePool`.

### 3. Load lazily, release when idle

Each wasm worker holds a full copy of the model (~0.28 GB), so the pool is the
single biggest memory cost in the app. It is therefore built **on demand** and
never speculatively at page load. Opening a book does **not** start it: the engine
first runs a cache/peer **warm pass** over the chunks around the playhead
(`_warm`/`_warmOne`), which needs no model at all. Only a *confirmed cache miss*
inside that window asks for the pool, via `TTSEngine.onNeedEngine` →
`ensureEngine()`. So a book whose audio is already cached — or available from a
linked peer — opens and plays with **zero** workers, whether it's played from the
start or seeked around. Other direct callers of `ensureEngine()` are voice previews
(a preview has no cache key, so it always needs a worker) and creating an
audiobook. Older builds called `ensureEngine()` unconditionally from `openBook()`
and, before that, pre-warmed the pool on every page load off a persisted
`engineWarmed` flag (both deliberately gone — the flag made every refresh pay the
full model-load for visitors who never listen; the `openBook` call spun up 16
workers just to stream audio that was already on disk).

The **warm pass** is deliberately split from the **prefetch pass**, because they
answer two different questions:

- `_warm`/`_warmOne` (`[focus - WARM_BEHIND, focus + WARM_AHEAD]`, i.e. 2 behind /
  20 ahead) *delivers* chunks to the player and is what triggers
  `onNeedEngine()` on a confirmed miss. Keeping it small bounds the per-`setFocus`
  work and how much audio the player keeps resident. Each chunk is only ever
  checked once per book, via `job.warmTried`. When a worker pool exists the
  workers churn through the whole queue regardless; this window only governs the
  no-worker path.
- `_prefetch`/`_prefetchOne` reaches `prefetchAhead`/`prefetchBehind` from the
  playhead (**both `Infinity` by default — the whole book**, via
  `PREFETCH_WINDOW` in `config.js`) and resolves chunks into the **local chunk
  cache** from the cache itself or a linked peer. It never touches the player and
  never asks for the engine, so it cannot stall playback or drag the pool up; a
  miss is simply left pending. This is what lets a phone mirror a whole book that
  was generated on a desktop — pull it all down in one go, then keep playing
  after that desktop is gone. The prefetch cursors walk outward from the
  playhead (ahead first, so the near future is in hand soonest), each chunk is
  tried once (`job.prefetchTried`), and bounded concurrency (`PREFETCH_MAX`,
  which `engine.fetchChunk`'s key-deduping coalesces into the peer broker's
  ≤12-key batches) keeps it from flooding a peer. Set finite window values via
  `engine.setPrefetchWindow({ahead, behind})` (it re-arms itself with
  `kickPrefetch()`) to restore the old lazy behaviour. The player counts
  prefetched-but-not-yet-delivered chunks in `readyCount`, so the buffered bar
  visibly fills as a whole book syncs in.

When the queue drains (`pendingCount === 0`, no busy worker, `_warmInFlight === 0`)
and no synthesis has happened for `ENGINE_IDLE_UNLOAD_MS` (4 min),
`tickEngineIdle()` (a 30 s interval) calls `TTSEngine.unload()`. Playback state is
deliberately **not** part of that condition: audio plays from already-synthesised
blobs, so a fully-computed book frees its pool even while the user is still
listening — only pending/busy/warm engine work counts as activity. `unload()`
terminates the workers but keeps the engine instance, its queued jobs, its cache
timer and its worker URL, so the next `setBook`/`setFocus`/`previewVoice`
rebuilds the pool in place. The status line shows "Ready when you are" while
unloaded. This is what keeps a background tab from pinning ~4.5 GB after a book
has finished.

### Considered and rejected: JAX.js (`@jax-js/jax`)

The published jax-js matmul benchmark (`jax-js-wasm` 603 GFLOP/s vs `onnx-wasm`
134 GFLOP/s) looks like a 4.5x kernel win, but it is a **thread-count artifact**:
their ORT baseline runs with `executionProviders: ["wasm"]` and no `numThreads`,
i.e. ORT's default `min(4, hw/2)`, while jax-js uses every core. Reproduced on a
64-core machine at 4096² f32:

| runner | threads | GFLOP/s |
| --- | --- | --- |
| onnxruntime-web (their default) | 4 | 135 |
| onnxruntime-web (`numThreads: 48`) | 48 | 609 |
| `@jax-js/jax` wasm | all | 603 |

So the 134 in the chart is exactly ORT-at-4-threads. At Kokoro-sized matrices
ORT is also ahead (e.g. 512×768·768×768: ORT 174 vs jax-js 104 GFLOP/s). Worse,
Kokoro's ORT graph is **int8** (`MatMulInteger`/`ConvInteger`), which jax-js has
no equivalent for (its feature table marks packed-uint8 unsupported), so a jax-js
port would do ~4x the arithmetic with no kernel advantage. And
`@jax-js/onnx`'s op coverage is far short of Kokoro's 56 ops — it is missing
`MatMulInteger`, `ConvInteger`, `DynamicQuantizeLinear`, `DequantizeLinear`,
`DynamicQuantizeLSTM`/`LSTM`, `FastGelu`, `SkipLayerNormalization`, `FusedMatMul`,
`STFT`, and more. Net: not worth it; the multi-worker ORT pool stays.

### 4. The Light voice (Paradee v1.1) — tiny engine

`paradee11_heart` ("Heart · Female · (8x Faster)" in the pickers) is
[Paradee v1.1](https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.1):
a 7.88M-parameter `af_heart` student in one 8.5 MB int8 ONNX file. Its new
sine+noise vocoder head is ~3.4x faster than v1.0 at raw inference on the
author's benchmark (62x vs 18.5x realtime, Apple M4 Pro, phonemes→audio only).
End to end in this app it measures ~80–110x realtime sustained on a many-core
desktop (single-run numbers move ±40% with background load on a shared box —
see `scratch/mp3-pool-tuning.md` — so read ranges, not points; always ≥8x
the full Kokoro pool's throughput). The fixed pipeline costs (G2P, WAV, MP3)
were profiled per stage and squeezed out: a TTS worker is released the moment
its WAV arrives (`_onWorkerMessage`, behind the `_releaseEarly` switch —
interleaved ABABAB benchmarking puts the gain at ~+10% median, never slower
in any pair), the buffer goes straight to the shared MP3 worker pool (1 on a
4-core phone, 6 on a big desktop — sized in `scratch/mp3-pool-tuning.md`; the
old singleton encoder serialized every
chunk), the main-thread WAV decode/re-encode round-trip is gone (duration
comes from the WAV header), and Light pools scale with cores within the
half-cores background budget (up to 16
workers on big desktops, 1 TTS + 1 MP3 worker on a 4-core phone). Book export
concatenates the chunk MP3s losslessly (`concatMp3Blobs`, zero-copy —
a 10-hour book merges in ~0.5 s) instead of decoding + re-encoding.
`titl_heart` ("Heart · Female · (6x Faster)", Teacher-in-the-Loop) and the
v1.0 `paradee_heart` id are gone from the pickers — both lost the side-by-side
to v1.1, so stored references resolve forward to `paradee11_heart`
(`LEGACY_VOICE_MAP` in `src/config.js`, applied everywhere a voice id is
read: settings, drafts, per-book narrators, shared bundles). Their engine
paths are kept as legacy fallbacks so nothing already saved breaks. The Light
voice needs no WebGPU and no 325 MB download, so it is the voice slow
devices get.

Architecture: `TTSEngine` holds **one worker pool per engine** (`this.pools`).
A worker loads exactly one model, and `_pump` routes each job by voice (see
`engineForVoice` in `src/paradee.js`). Each pool initialises lazily and only on
demand, so a Light-voice book never downloads Kokoro and vice versa. The worker
reuses kokoro-js for text → phonemes → token ids but converts eSpeak phonemes
to misaki spellings with `toMisaki()` (the student only learned misaki's spellings;
raw eSpeak phonemes mumble at 31% WER) and runs the Light graph through a
separate pinned onnxruntime-web copy (single-threaded — no SAB needed). The
tokenizer (`src/paradee-tokenizer.json`, vendored from the HF repo) is loaded on
the main thread and handed to workers, which fall back to the HF-hosted copy.

Single-download runtime bundle: `src/paradee11-rt.bundle` (19.7 MB, built by
`src/tools/build-paradee11-bundle.js`) packs the whole Light runtime — the
stripped JSEP-less ORT glue + wasm (see below), the v1.1 int8 model, and the
tokenizer. The main thread downloads it ONCE, slices it into memory-served
blob: URLs, and hands them to every pool worker via init params, so workers make
**zero** runtime fetches (verified with all remote fallbacks poisoned: 16/16
workers init from `blob`/`bundle` sources on desktop, first MP3 in <2 s, exactly one
bundle request). The runtime sections are shared by all three Light pools
(titl/paradee take only those; their models keep the existing single-flight
fetch). The workers' three static JS imports are pre-warmed on the main
thread (`warmLightJsCache`) so the pool burst resolves from HTTP cache.
Everything remote stays as fallback, so a damaged bundle degrades to the old
per-file downloads instead of breaking synthesis. Pool fill is ~1.3 s on
desktop (nothing downloads lazily any more, so the old first-tail bulk
gate and its throwaway warmup inference are deleted — bulk workers spawn
immediately).

Why JSEP-less: onnxruntime-web's default entry loads
`ort-wasm-simd-threaded.jsep.mjs` plus a 22 MB `jsep.wasm` side module that
every worker downloads at first inference even for pure-CPU sessions
(16 × 33 MB ≈ 528 MB — that was the "500 MB / 16 downloads" report; no
amount of spawn gating could fix it because all 16 first-inferences still
race). The wasm-only entry (`ort.wasm.min.mjs`) loads the plain threaded
build instead: one 11.2 MB file, no side module. Correctness: v1.1's vocoder
draws its own random breath noise (the model card says runs differ in the
noisy parts), so parity is distributional — same sample count, run-to-run
correlation 0.96, matching RMS/peak/zero-crossing — all confirmed against
the old build's output. Sustained throughput is unchanged (52x on a 24-chunk
run, inside the established 47–112x box-noise band).

Default-voice selection: fresh installs (no saved voice) probe the device once
at boot (`src/devicePerf.js`) and default to the Light voice when Kokoro's big
Heart default is unlikely to hold 2x realtime — few cores, little RAM, no
threaded wasm, a phone, or a slow JIT-hardened CPU micro-benchmark (warmup +
median of 5, variance-gated, capped ~600 ms, fails open to Kokoro). Only
clearly-slow devices flip; borderline ones keep Kokoro. The choice is
persisted (`voiceAuto`) and never overrides an explicit pick. The backstop for
slow devices is still the runtime monitor: the engine measures real per-chunk
synthesis speed (`onSpeed`) and the app suggests the Light voice once
(persisted, never nags) if Kokoro sustains < 1.5x realtime. The
background-thread budget is a hard rule everywhere: TTS + MP3 workers combined
never exceed half of `navigator.hardwareConcurrency`.
