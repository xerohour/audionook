# Audionook — self-hosted GitHub Pages port notes

Port of Johnny's Perchance generator `k2abgvi0mf` ("Audionook") to a static
site served from `https://xerohour.github.io/audionook/`. Source:
`~/workspace/audionook-port/original/` (read-only, unmodified). Output:
`~/workspace/audionook-port/game/`.

Design principle: the app already anticipated running off Perchance
(`net.js` treats websocket close code 4403 as "generator embedded off
perchance.org — permanent, never retry"). The port reuses that existing
graceful behavior wherever possible instead of inventing new UI.

## Files changed

### `index.html`
- **Removed** the entire `<script type="text/x-server-plugin">…</script>`
  block (original lines 91–652, 562 lines): the authoritative Explore
  listing backend. It cannot run on static hosting; the browser ignores the
  `text/x-server-plugin` type anyway, so this is pure dead weight.
- **Kept** the boot-splash inline script untouched.
- **Added** `<script src="src/port-shim.js"></script>` immediately before
  `<script type="module" src="src/app.js"></script>`.
- **Removed** the two Explore nav items (sideNav + bottomNav). The default
  landing route is already `create` (app.js line 42), so no default-route
  change was needed.

### `src/port-shim.js` (new)
Defines `window.root` before any module loads, replacing Perchance's
`root.*` plugin globals:
- `kv` — IndexedDB-backed folder factory. `root.kv[name]` returns
  `{get, set, delete, keys, entries, clear}`, all async, never throwing
  (catch → `undefined` / `[]`). One database (`audionook-kv`), one object
  store per folder name, created lazily. Used only as the OPFS fallback in
  storage.js.
- `superFetch(url, opts)` → plain `fetch(url, opts)`. The one call site
  (views.js URL text import) already falls back to fetch on error.
- `uploadPlugin` → `async () => ({ error: "Sharing needs the Perchance
  backend — unavailable in this standalone build." })`. share.js checks
  `res.error` and throws a clear message at every call site.
- `generateText` → `async () => ({ error: "AI features need the Perchance
  backend — unavailable in this standalone build." })`. Returns an object,
  **never throws**: call sites read `result.text` and treat empty as failure
  (moderation fails open by design; title inference keeps the provisional
  title — verified, see below).
- `generateImage` → `async () => ({ error: "Cover generation needs the
  Perchance backend — unavailable in this standalone build." })`.
- `createServerSocket` → throws `Error("Server features need the Perchance
  backend — unavailable in this standalone build.")` with
  `.code = "NO_PERCHANCE_SERVER"`, so net.js can route it to the existing
  permanent "blocked" path.

### `src/net.js` (1 surgical patch)
In `ServerNet._doConnect`'s catch: if the error has
`code === "NO_PERCHANCE_SERVER"`, emit `"blocked"` and return (the same
permanent, never-retry status used for close code 4403), instead of the
`"offline"` + infinite-reconnect path. This prevents a pointless 30-second
reconnect loop for the rest of the page's life.

### `src/app.js` (4 surgical patches)
1. `showRoute`: `if (route === "explore") route = "library";` — safety net
   for stray `navigate("explore")` calls (e.g. post-publish flows), since
   the Explore nav is hidden.
2. `reformatGenerate`: after `root.generateText(...)`, if the result has
   `.error`, throw `new Error(res.error)`. `Reformatter._segment` already
   catches this and marks the segment failed (`mode: "unparsed"`), so the
   stage degrades instead of trying to parse an error object as AI output.
3. Draft restore: `app.create.reformatOn = false` unconditionally, so a
   draft carried over from the hosted version can't show the AI panel.
4. Both cover-art "Generate"/"Paint one" buttons replaced with disabled
   placeholders + tooltip; upload-crop and remove options untouched.

### `src/views.js` (3 surgical patches)
1. Device sync chip: replaced with a disabled button + tooltip
   ("Device sync needs the Perchance server — unavailable in this
   standalone build"); click handler removed so `openDeviceSyncModal` is
   never opened from the Library bar.
2. Reformat text chip: disabled with tooltip; toggle handler removed.
3. Empty-library copy: "…or open something from Explore" removed.

### Untouched (by design)
`engine.js`, `audio.js`, `player.js`, `storage.js`, `store.js`,
`covers.js`, `crop.js`, `import.js`, `backup.js`, `fssync.js`,
`syncmeta.js`, `devicesync.js`, `paradee.js`, `paradee11.js`-adjacent code,
`devicePerf.js`, `config.js`, `util.js`, `ui.js`, `share.js`,
`reformat.js`, `styles.css`, the binary `src/paradee11-rt.bundle`
(sha256 `c7af3f19…d4686ce`, magic `P11BNDL1` verified identical),
`src/paradee-tokenizer.json`, `src/standalone-paradee11/*`,
`src/tools/*`, and all four docs (`README/SPEC/TASK/TODO.md`).

## Features disabled/degraded and why

| Feature | Treatment | Why |
|---|---|---|
| Explore tab + public listing | Nav hidden; route redirects to Library | Needs the server plugin backend |
| Explore "Try again" loop | Unreachable (nav hidden); net status is `blocked`, never retries | No backend to reach |
| Device sync chip | Disabled + tooltip | Needs the coordination socket |
| `?sync=` invite links | Left in place; fails through the existing "Couldn't reach the sync service" path | Reuses existing graceful behavior; no new UI |
| Share-link creation / Publish to Explore | Left in place; fails with the shim's clear error message via existing try/catch + toast | "route to the shim's clear error message" per spec |
| Opening `?b=` share links | **Works** — `resolveSharePayload` uses plain `fetch` to `user.uploads.dev` (the only allowed runtime use of that host) | No uploadPlugin needed to open |
| Cover "Generate"/"Paint one" | Disabled + tooltip | Needs `generateImage` |
| Cover upload/crop/remove | **Works** — fully local | No backend involved |
| Reformat-text chip | Disabled + tooltip; AI panel can never open | Needs `generateText` |
| AI title inference | **Degrades cleanly** — `deduceTitle` checks `if (!title) return;`; provisional first-line title is kept, no crash | `generateText` shim returns `{error}`, `result.text` → `""` |
| AI catalogue metadata (publish) | Fails with clear error via existing catch ("Couldn't reach the tagging service…") | Needs `generateText` |
| Listing moderation | Fails open (`{ok: true, failed: true}`) — the documented design | `generateText` shim has no `.text` |
| URL text import | **Works** — `root.superFetch` → `fetch`; existing fallback intact | Plain fetch |

## Verified working by code inspection

- **Boot**: `init()` → theme/nav/player/keyboard/deep-link/device-sync setup
  are all local; `app.net.connect()` → shim throws coded error → net emits
  `blocked` (no reconnect loop); `loadLibrary/loadCollections/loadBookmarks`
  use OPFS with the shim's kv as fallback; `loadExplore` fails into
  `st.error = true` without rendering (route can never be explore).
- **Create flow**: paste/import/file/URL text → draft → book creation →
  `deduceTitle` keeps the provisional title → player opens with TTS.
- **TTS engine**: untouched; bundle + tokenizer load from local relative
  URLs (`src/paradee11-rt.bundle`, `src/paradee-tokenizer.json`); model
  weights from huggingface.co / esm.sh / jsdelivr CDNs as before (fallbacks
  only — the vendored bundle is primary).
- **Player, library, folders, bookmarks, positions, backup/import, settings,
  themes**: all local (`storage.js`/`store.js` untouched).
- **No root-absolute URLs** in HTML/JS/CSS (grep verified; only `https://`
  CDN and `user.uploads.dev` share-link URLs remain, both by design).
- **No uncaught throws during boot/Library/Create/Player flows**: every
  `createServerSocket` call site is behind try/catch or the disabled UI;
  every `uploadPlugin`/`generateText`/`generateImage` call site either
  checks `res.error`, catches, or treats empty text as failure.
- **`standalone-paradee11/paradee11.js` is not imported by anything** — the
  app uses `paradee.js`'s own loader with local URLs, so its
  `user.uploads.dev` default bundle URL is never fetched at runtime.

## Syntax check

`node --check` passed on all 23 JS files (22 ES modules checked via a
`.mjs` copy, `port-shim.js` checked as a classic script). `styles.css`
not applicable.

## Notes for the uploader

- Serve from the project subpath `/audionook/` — all URLs are relative,
  no base-tag or subpath patching needed.
- The 28 MB `src/paradee11-rt.bundle` must be served with correct bytes
  (GitHub Pages serves `.bundle` as `application/octet-stream` by default;
  the loader only needs the bytes via `fetch`).
- `?b=` share links opened on the Pages site fetch from
  `https://user.uploads.dev/file/<id>.json` — existing shares keep working.
- `$meta.dynamic` link previews from main.pjs do not apply to the static
  site (no server sandbox); shared links will show the static
  title/description from the HTML head.
