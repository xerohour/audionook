# TODO

Working notes for whoever picks this up next. See `TASK.md` (brief), `SPEC.md`
(what it should do) and `README.md` (how it's built).

## Verified working
- Boot with no console errors; Explore / Library / Create render (Create is default).
- Fresh synthesis → playback starts after the first chunk while the rest build.
- Deep link (`?b=<id>`) opens the shared book; `$meta.dynamic` gives the link a per-book title/cover preview.
- View-time NSFW check reaches the host API and returns a real verdict.
- Server submit/list/report/stats over the emulator; pubsub delivery.
- Mobile 390×844 and desktop 1440×900 layouts.
- Document import: txt / md / html / rtf / pdf / docx / epub / odt all parse to text
  (pdf.js worker served as a blob from the jsdelivr self-contained bundle).
- Backup export → import round-trip (tiny zip, books+folders+positions restored).
- Playback stress test with instrumented `<audio>` elements: never two playing at
  once; skip past the last chunk clamps inside it; straggler `ended` ignored;
  `onBookEnd` fires once.
- Collections: new collection → add book → breadcrumb navigation; archive/restore.
- Collections as queues: reorder by drag (insertion line) and via "Move up/down";
  "Play all" starts the collection; the queue advances book-to-book.
- Context menu (right-click / long-press): compact popup on library and Explore
  cards, clamped inside the viewport (incl. under a scrollbar) at phone width.
- Storage layer reports the OPFS backend; per-book narrator override; "Mark as
  unread"; compact option pills; sticky modal close button; local-folder sync box.
- Local-folder sync is hidden when the picker can't be shown here: `fssync.isAvailable()`
  detects a cross-origin subframe (the Perchance case) and the Backup modal then
  renders only Export/Import (no failing "Sync" button).
- Black theme: pure-black flats, muted greys, no bright fills.
- Settings voice preview is icon-only; sleep timer is a `<select>` with 2h/3h.
- **Chunker** no longer splits at abbreviations/acronyms/initials ("Mr. Smith",
  "U.S. Army", "K.I.S.S.", "e.g.", "Ph.D.", "3.14", "example.com"). Also robust
  to a quoted abbreviation (`'Mr. Darcy`), a period before a comma (initial
  "from B., intending"), and a sentence-final domain ("…at example.com. Then…"
  still breaks). Checked against the Hyundai book text and Gutenberg's Pride &
  Prejudice: 0 boundaries inside such tokens (was 200+ on Pride specifically).
  Paragraph breaks still win.
- **Player stall** fixed and unit-tested: advancing/seeking to a chunk that isn't
  synthesised yet now moves the playhead, so the later arrival resumes playback
  instead of sitting on "buffering" until pause/unpause.
- **wasm (backup) inference ~2.4x faster** via a many-small-sessions pool
  (`computePool` in `src/engine.js`): 1×nt=4 focus worker + 15×nt=2 bulk workers,
  measured 3.85 → 9.08 audio-sec/wall-sec on 48 chunks (64-core machine). Root
  cause fixed too: `kokoro-js` is loaded without `?bundle` so ORT's
  `numThreads` is actually reachable. End-to-end through the app engine (incl.
  MP3) ~7-8 audio/sec; all 48 chunks decode to valid non-silent audio. Total
  background threads (TTS + MP3) are capped at **half of
  `navigator.hardwareConcurrency`** (hard rule — a 4-core phone runs 1 TTS + 1
  MP3 worker). Remaining: a real-device pass on a mid/low-core machine.
- **JAX.js (`@jax-js/jax`) investigated and rejected.** Its headline wasm-matmul
  benchmark (603 vs 134 GFLOP/s) is a thread-count artifact — their ORT baseline
  ran at ORT's default 4 threads. Fairly threaded, ORT matches/exceeds jax-js
  (609 vs 603 at 4096²; ahead at Kokoro shapes) and Kokoro runs int8 in ORT,
  which jax-js lacks. `@jax-js/onnx` is also missing ~10 of Kokoro's ops
  (quantized ops, LSTM, FusedMatMul, STFT, …). Do not re-attempt without new
  evidence. Details in README "wasm speedup".
- Reader top bar: theme + settings buttons, an inline `…` options button.
- Scrubber click scrolls the reader to the **chunk holding up playback** (the one
  being synthesised, which also pulses via `.chunk.buffering`) rather than to the
  last chunk that finished — verified the target chunk lands exactly centred.
- Autoscroll: deliberate scroll-away shows a "Return to auto-scroll" pill;
  tiny nudges don't leave autoscroll; clicking the pill/scrubber/chunk resumes.
  Reader scrolling uses the gen-guarded `animateReaderScroll` rAF animator, not CSS
  `scroll-behavior:smooth` (removed — it made programmatic `scrollTop` uncancellable).
- Library: folders render in their own `.folder-grid` segment above the book
  `.lib-grid`; folder cards are short single-row tiles on desktop and full-width
  rows at phone width. **Book cards are compact** (~175×178 px desktop): a
  landscape 1.7:1 cover (title/author inside it) plus a 2-line title and a single
  `author · duration · tags` meta line; the `.lib-grid` is `minmax(170px,1fr)`
  (~4 cols desktop, 2 at 390px phone). Explore/search `.card`s share the style.
- `#npOptsBtn` (`.icon-btn`) icon is optically centred in its hover circle now
  that `.icon-btn` sets `padding:0` (UA button padding was offsetting the SVG).
- Clicking the currently-playing library row opens the reader without restarting.
- ≥98% listened auto-marks a book read; read/unread action uses the new
  page+dot icons; library Filter popover (read status + tags) filters correctly.
- Playing book is indicated on its library/explore card: amber outline + glow
  (`.card.current`), an animated equaliser play badge while playing
  (`.card.playing`), and a live `.card-progress` bar driven by
  `syncPlayingCards()` on every player tick (verified by faking player state via
  `_emit()`: bar tracked 20% → 60% and the badge animation started/stopped with
  `isPlaying`).
- Collection/folder cards now share the book-card interaction model: the ⋯ button
  opens the full "Collection" modal, while right-click (and long-press on touch)
  opens a compact context popup (`folderContextMenu`) with Open, Play all (only
  when the folder has books), New subfolder, Rename…, Delete, More options….
  Verified the popup renders with the right items, that Play all starts a
  collection queue, and that the ⋯ modal still opens.
- **Create "Reformat text"** (off by default; chip to the right of "Open a file…").
  Segments the text (≤360 words, paragraph/sentence-aware), sends each to
  generateText sequentially, and the model picks diffs vs. a full rewrite per
  segment via the edit protocol. Verified live: the toggle reveals the bar; a
  custom preset reveals the input with the "e.g. convert to english" placeholder;
  Run disables below 3 words; the stage replaces Create with a per-segment card
  (colored before/after diff + badge), progress bar, streamed model reply, and the
  summary; Stop halts ("Reformat stopped", Use appears); Retry recovers a failed
  segment (1 failed → 0 failed); Use applies the text back to the textarea +
  draft. Prompt quality checked against the OCR sample (TOC/boilerplate removed,
  clean prose left alone → `NONE`), Gutenberg *Alice* (.txt) and *Pride &
  Prejudice* (.epub), a synthetic scanned PDF (page numbers/running heads removed,
  page-break-split sentences rejoined → "mended N split line(s)"), and a
  translation. Raw output logs live in `scratch/reformat-tests/` (ephemeral).
  Layout verified: at desktop the chip sits immediately right of "Open a file…"
  and before "Clear" (one row); at 390px the actions wrap sensibly, nothing
  overflows, and the bar footer stacks (hint above a full-width Reformat button).
  Remaining: a real-device pass (the requests are live model calls, so this is
  slower/heavier on mobile).
- **Device sync** ("Device sync" chip right of Import in the Library toolbar).
  Verified with **two engines in one page** over the real emulator coordination
  socket + a real WebRTC DataChannel: a first sync copied a book (meta+text), a
  collection, a bookmark and a position both ways; a re-run transferred **0 items**
  (idempotent); a delete on one side tombstoned the other; a newer edit won; a
  newer edit **resurrected** a deleted book. The **relay fallback** (WebRTC stubbed
  out) transferred an 18 KB text + 5 KB cover through an encrypted 1 h upload and
  the sender's upload was deleted after ack. UI verified at desktop + 390×844:
  intro and linked views render (fingerprint, Sync now, Copy invite link, Stop
  syncing), a garbage link errors without linking, and the real link links with a
  matching fingerprint. Server side is coordination-only: ephemeral in-memory
  rooms, never touches the durable Explore `state`.
- **Peer chunk sharing** (on-demand audio from a synced device). Verified with two
  engines in one page: a 4 KB chunk fetched over the real WebRTC DataChannel
  matched byte-for-byte; a key the peer doesn't hold resolves `null` quickly
  (via the `chno` reply, not by waiting out the timer); a two-key burst coalesces
  into a single request; and with WebRTC stubbed out the **relay** path returned
  four chunks of sizes 3000/3011/3022/3033 intact. `TTSEngine._warm()` was
  stub-worker tested: peer-held chunks are delivered exactly once with **no**
  synthesis, a worker ready at the same time never double-delivers, and the
  remaining chunks still synthesise normally. Cache-first warm is also verified
  **without any fetcher** (a fully-cached book served with zero workers) and a
  confirmed cache miss still brings the pool up and synthesises. The whole-book
  **prefetch** pass (`_prefetch`) is unit-tested too: with a stub fetcher it
  resolves all 30 chunks into the local cache with **no** engine request; a
  finite window (`prefetchAhead:3, prefetchBehind:2` at focus 20) resolves
  exactly the 6 chunks in range; an all-missing book exhausts in ~20 ms and never
  asks for the engine; and `kickPrefetch()` (used when a peer appears) re-arms a
  drained pass and pulls everything. In the real app, opening a fully-cached
  2416-chunk book marks the whole book ready in ~1.1 s with **zero** workers.
- **Cross-book audio bleed** fixed. Opening book A starts synthesising it; going
  back and opening book B used to leave a worker finishing A's in-flight chunk,
  whose result was then delivered at A's index — and since the player keys audio
  by index, A's chunk 0 overwrote B's chunk 0, so B played A's opening. Jobs now
  carry a **book token** (bumped in `setBook`) and `_completeJob`/`_failJob` (and
  `_dispatch`'s post-probe path) discard results whose token is stale, freeing the
  worker for the new book instead. Unit-tested: a stale `_completeJob`/`_failJob`
  delivers nothing and frees the worker, a current-book job still delivers, and a
  voice-preview (one-off) job is never discarded.
- **Card badge states**: a `.card.current` that is paused now keeps the ordinary
  play icon; only `.card.current.playing` swaps in the animated equaliser
  (verified via computed styles: plain → play/none, current → play/none,
  current+playing → none/eq).
- **Per-book cover art (local-first + cropper)**: Options → **Cover art** opens a
  picker (Choose image / Paint one / Adjust crop / Remove / Save cover). Choosing
  an image opens a pan/zoom **cropper** locked to the card's 1.7:1 slot. Verified:
  a 1400×900 PNG was cropped to a 720×424 JPEG (ratio 1.698) and, on **Save
  cover**, stored as a local blob (`coverLocal`, `coverUrl` still empty) that the
  library card rendered from an object URL — **with zero `uploadPlugin` calls**.
  Survives a reload (rehydrated from the stored blob). Opening **Share** then did
  exactly three uploads — text, the cover JPEG, and the share-meta `.json` — and
  set `coverUrl` to the uploaded URL. Publish-to-Explore uploads the cover the same
  way. Backup exports it as `covers/<id>.jpg`.

## To verify / do
- [ ] Real-device pass on **peer chunk sharing**: generate a book on one device,
      link a second, open on the second and confirm playback streams from the peer
      (no synthesis) even before its own model is warm. Also confirm the new
      whole-book **prefetch** mirrors the entire book to the second device's local
      cache (buffered bar reaches 100%) so the first device can then be closed and
      the book keeps playing. The one-tab editor emulator can't do this — needs
      two real devices (or two real browsers) on the same sync group.
- [ ] On a real long book, confirm the stall fix holds across many chunk
      transitions and that the 1 s unstick watchdog never fights normal playback.
- [ ] Real-device/touch check of the autoscroll "return to auto-scroll" pill.
- [ ] **Publish flow end to end on the real server** (needs a save; emulator state
      resets on refresh). Confirm rate limits, dedupe, and `seq` assignment.
- [ ] Exercise the **NSFW-hidden** branch with a genuinely flagged file (the API
      path is verified; the "hide + toast" branch has only been code-reviewed).
- [ ] Drag-and-drop has been checked via drop events, not with a real pointer drag
      on a touch device — spot-check on mobile.
- [ ] Consider a search index in the server script if listings ever get large
      (query search currently scans in rank order; unfiltered browse is early-exit).
- [x] **Explore record compression (done).** The slot now stores only the small
      numeric metadata the server searches/sorts on, plus `title`/`author` (for
      the text query) and the 32-hex id of a tiny uploaded `.json` bundle holding
      the bulky display/playback fields (blurb/textUrl/coverUrl/voice). `SLOT_SIZE`
      is 656 → 272 B (the 32-byte tag mask is the extra cost vs the old 240 B
      slot), i.e. ~180k books at 50 MiB. The feed lazily fetches each row's bundle
      (`share.fetchBundle` → `share.applyBundle`) and swaps the card in place.
- [x] **Tags broadened to 256 + state format v3.** `TAGS` grew from a handful
      to 256 tags (classic plus modern/emerging: villainess, otome, isekai,
      transmigration/regression/reincarnation, LitRPG/system, romantasy, dark
      academia, solarpunk, etc.); the mask is a **32-byte / 256-bit** field (`tagBits`,
      64 hex on the wire) so up to 256 tags can exist, and a book may carry **8**
      (was 3). `STATE_VERSION` 2 → 3 (a mismatch wipes state; no legacy migration —
      the app hasn't launched). Server list filter is tag-mask-any-of + text query;
      the old max-rating filter and the all-zero-mask-name-matches bug are gone
      (an empty filter is sent as `""`). Verified over the emulator: single-tag
      OR filters, no-filter browse, and per-row tag parsing.
- [x] **No content rating anywhere; NSFW is view-time only.** The publish form has
      no rating input, the share metadata and server record carry no rating, and
      the 18+ card badge keys off `book.nsfw` (resolved at load). The Explore feed
      (and a deep link) asks the host for the real tags of **textUrl and coverUrl**
      after hydration and hides flagged rows. `MAX_BLURB` raised to 1100 (the blurb
      lives only in the uploaded bundle, never in server state).
- [x] **Publish UX + AI moderation.** The catalogue form stays hidden (Publish
      disabled) until the metadata suggestion finishes, so nothing stale shows; the
      lingering "Reading the story to tag it…" is cleared when it completes. On the
      final Publish, an untouched AI draft skips review entirely; if the author
      edited the draft, `share.moderateListing` runs an ai-text-plugin moderation
      pass that rejects spam/trolling (aborts with the reason) and applies any
      corrected title/author/blurb/tags before the record is built. Fails open.
      The pass is deliberately unadvertised — no status text, just a spinner on the
      Publish button (so a tampering client isn't tipped off). Verified both the
      accept (moderated fields submitted, flags=AI_TAGS) and reject paths live,
      plus the clean-skip path and phone-width layout.
- [ ] Optional: admin/featured tooling (the `FEATURED_BIT` is defined but nothing
      sets it yet).
- [ ] Optional: comments on books via comments-plugin (not currently imported).
- [ ] Sleep timer / download-MP3 / voice preview: spot-check on a real device
      (desktop emulation can't test the browser's download UX).
- [ ] **"Sync with a local folder"**: the module is now hidden whenever
      `fssync.isAvailable()` is false (API missing *or* a cross-origin subframe —
      Perchance's case), so it no longer renders a button that always fails. The
      remaining check is the happy path: open the generator top-level on a desktop
      browser (where the picker *is* allowed) and confirm the native picker + real
      write to a user folder end-to-end.
- [ ] Context-menu long-press path with a real touch pointer (drag handlers have
      only been exercised with synthetic events).

## Notes / gotchas
- Terminology is **"tags"**, not "genres" (renamed everywhere: `TAGS`, `tagBits`,
  `.tag-btn`/`.tag-pop`/`.tag-cloud`/`.tag-filter`, `book.tags`, the AI prompt's
  `"tags"` key, and all UI copy). `src/store.js` `normalizeBook()` folds a legacy
  `genres` key into `tags` on read so a pre-existing local library doesn't lose
  its tags; drop the shim whenever it's no longer needed.
- The server plugin's durable state is per-iframe and resets on `page_refresh`
  while the generator is unsaved.
- `#searchInput` needs `box-sizing:border-box` because the platform injects
  `input[type=search]{box-sizing:content-box}`.
- Share links use the query string (`?b=<id>`) so `$meta.dynamic` can read the id server-side for link previews; `readDeepLink()` parses `location.search`.
- Covers: published books usually have AI-generated art; the procedural covers
  are the fallback for local books and are purely CSS (8 variants).
- PDF parsing needs a self-contained worker bundle: esm.sh's `pdf.worker.mjs` is
  just a shim with root-relative imports that break inside a blob worker, so
  `src/import.js` fetches `pdfjs-dist`'s worker from jsdelivr and wraps it in a
  Blob URL (`new Worker(blobUrl, {type:"module"})`).
- **Do not add `?bundle` to the kokoro-js import in `src/engine.js`.** Without it,
  `@huggingface/transformers` is a shared module and its `env` (and thus ORT's
  `numThreads`) is reachable from `workerCode`; with it, transformers is trapped
  in an IIFE closure and every session falls back to ORT's default thread count.
  See README "wasm speedup".
