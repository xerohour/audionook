// ===========================================================================
// store.js — local persistence (kv-plugin): the user's library, settings,
// per-book playback positions, and a cache of NSFW checks.
// ===========================================================================

import { DEFAULT_VOICE, PARADEE11_VOICE_ID, resolveVoice } from "./config.js";
import { contentHash, contentHashBytes } from "./util.js";
import * as storage from "./storage.js";
import * as syncmeta from "./syncmeta.js";

const libraryFolder = storage.folder("library");       // id -> book metadata (no text)
const textsFolder = storage.folder("texts");           // id -> full text (kept separate so listings stay light)
const coversFolder = storage.folder("covers");         // id -> cover image blob (kept local until shared)
const settingsFolder = storage.folder("settings");
const positionsFolder = storage.folder("positions");   // id -> {index, offset, progress, listenSec, updatedAt}
const nsfwFolder = storage.folder("nsfwCache");        // url -> {nsfw, at}
const collectionsFolder = storage.folder("collections"); // id -> {id, name, parentId, createdAt}
const bookmarksFolder = storage.folder("bookmarks");   // id -> {id, bookId, index, offset, sec, note, tags, ...}
const draftFolder = storage.folder("drafts");          // unsaved Create-pane draft (text + chosen voice)

export { storage };

// --- content fingerprints (used by Device sync) -----------------------------
function hashStr(h) { return h.a.toString(16).padStart(8, "0") + h.b.toString(16).padStart(8, "0"); }
// Key-order-independent serialisation, so two devices compute the same
// signature for conceptually identical records.
function canon(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}
function canonSig(obj) { return hashStr(contentHash(canon(obj))); }
function textSig(text) { return text == null ? null : hashStr(contentHash(String(text))); }
export async function blobSig(blob) {
  if (!blob) return null;
  try { return hashStr(contentHashBytes(new Uint8Array(await blob.arrayBuffer()))); } catch (e) { return null; }
}
// A small, stable projection of a book's metadata (never its prose) — enough to
// break ties and to detect "same content, different revision".
function bookSig(b) {
  return canonSig({
    t: b.title, a: b.author, u: b.updatedAt, w: b.wordCount,
    c: b.collectionId, o: b.order, ar: !!b.archived, f: !!b.finished,
    th: b.textHash || null, ch: b.coverHash || null,
    cl: !!b.coverLocal, cu: b.coverUrl || "", tg: b.tags || null,
  });
}

const DEFAULT_SETTINGS = {
  safeMode: true,
  theme: "auto",          // auto | light | dark | black
  rate: 1,
  fontSize: 1,
  voice: DEFAULT_VOICE,
  voiceAuto: false,     // true when the current voice is just the auto default
  slowHintShown: false, // one-time "Kokoro is slow here, try Light" suggestion
  autoScroll: true,
  slowMode: false,        // force CPU-only TTS
  installedAt: 0,
};

let _settings = null;

export async function getSettings() {
  if (_settings) return _settings;
  let saved = null;
  try { saved = await settingsFolder.get("app"); } catch (e) {}
  _settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  // A stored narrator may name a retired voice (see resolveVoice) — fold it
  // forward so pickers never render a blank <select>.
  _settings.voice = resolveVoice(_settings.voice) || DEFAULT_VOICE;
  // Fresh install (no saved voice yet): probe the device once and default to
  // the Light voice when Kokoro's big Heart default is unlikely to hold 2x
  // realtime. Existing users keep whatever they have — this never overrides an
  // explicit choice. The probe is cheap (<~600 ms, fails open to Kokoro) and
  // its result is persisted so later boots skip it. See src/devicePerf.js.
  if (!saved || saved.voice == null) {
    try {
      const { shouldDefaultToLight } = await import("./devicePerf.js");
      if (await shouldDefaultToLight()) _settings.voice = PARADEE11_VOICE_ID;
      _settings.voiceAuto = true;
    } catch (e) {}
  }
  if (!_settings.installedAt) _settings.installedAt = Date.now();
  // Persist the auto-picked default so later boots skip the probe. A later
  // explicit voice change clears `voiceAuto` (see setSetting).
  if ((!saved || saved.voice == null) && _settings.voiceAuto) {
    try { await settingsFolder.set("app", _settings); } catch (e) {}
  }
  return _settings;
}

export async function setSetting(key, value) {
  const s = await getSettings();
  s[key] = value;
  if (key === "voice") s.voiceAuto = false;
  try { await settingsFolder.set("app", s); } catch (e) { console.warn(e); }
  return s;
}

// Ask the browser to make this origin's storage persistent, so the library and
// audio cache aren't evicted under storage pressure. Already-persisted origins
// resolve true without prompting; unsupported/denied contexts just return false.
export async function ensurePersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (e) {
    return false;
  }
}

// --- create-pane draft -----------------------------------------------------
// The Create pane keeps the in-progress text (and chosen narrator) here so a
// page refresh doesn't lose work that hasn't become an audiobook yet. Cleared
// (text) once the book is created.

export async function getCreateDraft() {
  try {
    const d = (await draftFolder.get("create")) || null;
    if (d && d.voice) d.voice = resolveVoice(d.voice) || DEFAULT_VOICE;
    return d;
  } catch (e) { return null; }
}

export async function saveCreateDraft(patch) {
  try {
    const cur = (await draftFolder.get("create")) || {};
    await draftFolder.set("create", { ...cur, ...patch, updatedAt: Date.now() });
  } catch (e) { console.warn(e); }
}

// --- library ---------------------------------------------------------------
// Older saves used `genres`; fold it into `tags` on read so a rename doesn't
// orphan a pre-existing local library's tags. (Nothing shipped, so this shim
// can be dropped whenever.)
function normalizeBook(b) {
  if (b && b.tags == null && Array.isArray(b.genres)) b.tags = b.genres;
  // A per-book narrator may name a retired voice — fold it forward ("" / null
  // still mean "follow the default").
  if (b && b.voice) b.voice = resolveVoice(b.voice) || null;
  return b;
}
export async function listLibrary() {
  let entries = [];
  try { entries = await libraryFolder.entries(); } catch (e) { console.warn(e); }
  return entries
    .map(([, v]) => v)
    .filter(Boolean)
    .map(normalizeBook)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}
export async function getBook(id) {
  try { return normalizeBook(await libraryFolder.get(id)); } catch (e) { return null; }
}
export async function putBook(book) {
  // Text lives in its own folder so listing the library never loads megabytes
  // of prose into memory, and metadata patches stay tiny.
  const { text, chunks, ...meta } = book;
  meta.updatedAt = Date.now();
  if (text != null) meta.textHash = textSig(text);
  await libraryFolder.set(book.id, meta);
  if (text != null) { try { await textsFolder.set(book.id, text); } catch (e) { console.warn(e); } }
  syncmeta.markChanged("book", book.id);
  return book;
}
export async function getText(id) {
  try { return await textsFolder.get(id); } catch (e) { return null; }
}

// --- cover art --------------------------------------------------------------
// A cover the user adds is kept on the device as an image blob; `coverLocal` on
// the book metadata says one exists. It is only uploaded when the book is shared
// (a share link or a publish to Explore), so `coverUrl` stays empty until then.
export async function getCover(id) {
  try { return await coversFolder.get(id); } catch (e) { return null; }
}
export async function putCover(id, blob) {
  await coversFolder.set(id, blob);
  try {
    const b = await getBook(id);
    if (b) { b.coverHash = await blobSig(blob); b.updatedAt = Date.now(); await libraryFolder.set(id, b); }
  } catch (e) { console.warn(e); }
  syncmeta.markChanged("book", id);
  return blob;
}
export async function deleteCover(id) {
  try { await coversFolder.delete(id); } catch (e) {}
  try {
    const b = await getBook(id);
    if (b && b.coverHash) { b.coverHash = null; b.updatedAt = Date.now(); await libraryFolder.set(id, b); }
  } catch (e) {}
  syncmeta.markChanged("book", id);
}
export async function patchBook(id, patch) {
  const b = await getBook(id);
  if (!b) return null;
  Object.assign(b, patch, { updatedAt: Date.now() });
  await libraryFolder.set(id, b);
  syncmeta.markChanged("book", id);
  return b;
}
export async function removeBook(id) {
  try { await libraryFolder.delete(id); } catch (e) {}
  try { await textsFolder.delete(id); } catch (e) {}
  try { await coversFolder.delete(id); } catch (e) {}
  try { await positionsFolder.delete(id); } catch (e) {}
  for (const bm of await listBookmarks()) {
    if (bm.bookId === id) { try { await bookmarksFolder.delete(bm.id); } catch (e) {} }
  }
  syncmeta.markDeleted("book", id);
}

// --- bookmarks --------------------------------------------------------------
// A bookmark is a remembered spot (chunk index + seconds into it) with an
// optional note and free-form tags. `bookTitle`/`snippet`/`sec` are denormalised
// at save time so the bookmarks view can render without loading every book's
// prose.
export async function listBookmarks() {
  let entries = [];
  try { entries = await bookmarksFolder.entries(); } catch (e) { console.warn(e); }
  return entries
    .map(([, v]) => v)
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
export async function getBookmark(id) {
  try { return await bookmarksFolder.get(id); } catch (e) { return null; }
}
export async function putBookmark(bm) {
  await bookmarksFolder.set(bm.id, bm);
  syncmeta.markChanged("bookmark", bm.id);
  return bm;
}
export async function patchBookmark(id, patch) {
  const bm = await getBookmark(id);
  if (!bm) return null;
  Object.assign(bm, patch);
  await bookmarksFolder.set(id, bm);
  syncmeta.markChanged("bookmark", id);
  return bm;
}
export async function removeBookmark(id) {
  try { await bookmarksFolder.delete(id); } catch (e) {}
  syncmeta.markDeleted("bookmark", id);
}

// --- collections (folders, arbitrarily nested via parentId) -----------------
export async function listCollections() {
  let entries = [];
  try { entries = await collectionsFolder.entries(); } catch (e) { console.warn(e); }
  return entries
    .map(([, v]) => v)
    .filter(Boolean)
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
}
export async function getCollection(id) {
  try { return await collectionsFolder.get(id); } catch (e) { return null; }
}
export async function putCollection(col) {
  await collectionsFolder.set(col.id, col);
  syncmeta.markChanged("collection", col.id);
  return col;
}
// Removing a folder never deletes its contents: books and subfolders are lifted
// into the folder's own parent so nothing is ever lost.
export async function removeCollection(id, { books = [], collections = [] } = {}) {
  const col = await getCollection(id);
  if (!col) return;
  const parentId = col.parentId ?? null;
  for (const b of books) {
    if ((b.collectionId ?? null) === id) await patchBook(b.id, { collectionId: parentId });
  }
  for (const c of collections) {
    if ((c.parentId ?? null) === id) await putCollection({ ...c, parentId });
  }
  try { await collectionsFolder.delete(id); } catch (e) {}
  syncmeta.markDeleted("collection", id);
}
export async function clearCollections() {
  try {
    const keys = await collectionsFolder.keys();
    for (const k of keys) { await collectionsFolder.delete(k); syncmeta.markDeleted("collection", k); }
  } catch (e) {}
}

// --- backup primitives ------------------------------------------------------
// What a backup bundle contains: every book's metadata + prose, folder layout,
// and playback positions. Audio is never stored (it is regenerated on demand),
// which keeps a full-library backup tiny.
export async function collectForBackup({ includeArchived = false } = {}) {
  const books = (await listLibrary()).filter((b) => includeArchived || !b.archived);
  const texts = {};
  const positions = {};
  const covers = {};
  for (const b of books) {
    const t = await getText(b.id);
    if (t != null) texts[b.id] = t;
    const p = await getPosition(b.id);
    if (p) positions[b.id] = p;
    if (b.coverLocal && !b.coverUrl) {
      const c = await getCover(b.id);
      if (c) covers[b.id] = c;
    }
  }
  const collections = await listCollections();
  const keptFolders = new Set();
  const byId = new Map(collections.map((c) => [c.id, c]));
  for (const b of books) markAncestors(b.collectionId, byId, keptFolders);
  for (const c of collections) markAncestors(c.parentId, byId, keptFolders);
  const keptBooks = new Set(books.map((b) => b.id));
  const allBookmarks = await listBookmarks();
  return {
    books,
    texts,
    positions,
    covers,
    collections: collections.filter((c) => keptFolders.has(c.id)),
    bookmarks: allBookmarks.filter((bm) => keptBooks.has(bm.bookId)),
  };
}

function markAncestors(id, byId, out) {
  let guard = 0;
  while (id != null && byId.has(id) && guard++ < 64) {
    if (out.has(id)) break;
    out.add(id);
    id = byId.get(id).parentId ?? null;
  }
}

export async function importBundle({ books = [], texts = {}, positions = {}, covers = {}, collections = [], bookmarks = [] }, { overwrite = false } = {}) {
  let imported = 0, skipped = 0;
  const existingCols = new Set((await listCollections()).map((c) => c.id));
  for (const c of collections) {
    if (!c || !c.id) continue;
    if (existingCols.has(c.id)) continue;
    await putCollection({ id: c.id, name: c.name || "Folder", parentId: c.parentId ?? null, createdAt: c.createdAt || Date.now() });
  }
  for (const b of books) {
    if (!b || !b.id) continue;
    if (!overwrite && (await getBook(b.id))) { skipped++; continue; }
    const meta = { ...b };
    delete meta.chunks;
    if (covers[b.id]) {
      meta.coverLocal = true;
      try { await coversFolder.set(b.id, covers[b.id]); } catch (e) {}
    }
    await libraryFolder.set(b.id, meta);
    if (texts[b.id] != null) { try { await textsFolder.set(b.id, texts[b.id]); } catch (e) {} }
    if (positions[b.id]) { try { await positionsFolder.set(b.id, positions[b.id]); } catch (e) {} }
    syncmeta.markChanged("book", b.id);
    if (positions[b.id]) syncmeta.markChanged("position", b.id);
    imported++;
  }
  for (const bm of bookmarks) {
    if (!bm || !bm.id || !bm.bookId) continue;
    if (!overwrite && (await getBookmark(bm.id))) continue;
    try { await bookmarksFolder.set(bm.id, bm); } catch (e) {}
    syncmeta.markChanged("bookmark", bm.id);
  }
  return { imported, skipped };
}

// --- playback positions -----------------------------------------------------
export async function getPosition(id) {
  try { return await positionsFolder.get(id); } catch (e) { return null; }
}
export async function savePosition(id, pos) {
  try {
    const next = { ...pos, updatedAt: Date.now() };
    const prev = await positionsFolder.get(id);
    await positionsFolder.set(id, next);
    // Only a real change (a new spot, not just a timestamp refresh from the
    // 30s heartbeat) becomes a new revision — otherwise every device would
    // re-sync positions forever.
    const changed = !prev
      || prev.index !== next.index || prev.offset !== next.offset || prev.progress !== next.progress;
    if (changed || !syncmeta.isTracked("position", id)) syncmeta.markChanged("position", id);
  } catch (e) {}
}

// --- NSFW cache -------------------------------------------------------------
// A URL is only checked once; results persist so listings don't re-hit the API.
export async function getNsfw(url) {
  if (!url) return null;
  try {
    const rec = await nsfwFolder.get(url);
    if (rec && Date.now() - rec.at < 1000 * 60 * 60 * 24 * 30) return rec.nsfw;
  } catch (e) {}
  return null;
}
export async function setNsfw(url, nsfw) {
  if (!url) return;
  try { await nsfwFolder.set(url, { nsfw: !!nsfw, at: Date.now() }); } catch (e) {}
}

// ===========================================================================
// Device sync primitives
// ---------------------------------------------------------------------------
// Read/apply helpers used by devicesync.js. These deliberately bypass the
// change-tracking hooks above: when a peer's record wins, the revision is set
// explicitly by the sync protocol (syncmeta.setRev), and a local markChanged
// here would bump it again and cause both devices to ping-pong forever.
// ===========================================================================

// One entry per record this device holds, plus a tombstone entry per deletion.
// `rev` orders records; `sig` only breaks exact ties (identical clocks).
export async function syncManifest() {
  const items = [];
  const live = new Set();
  const push = (type, id, rev, sig) => {
    live.add(type + ":" + id);
    items.push({ type, id, rev, del: false, sig });
  };
  for (const b of await listLibrary()) {
    // Fingerprints let the peer ask for only the blobs that actually differ.
    const h = await syncBookHashes(b.id);
    const meta = (h && h.meta) || b;
    const item = {
      type: "book", id: b.id, rev: syncmeta.revOf("book", b.id, b.updatedAt || b.createdAt),
      del: false, sig: bookSig(meta),
    };
    if (h) { item.th = h.textHash || null; item.ch = h.coverHash || null; }
    live.add("book:" + b.id);
    items.push(item);
  }
  for (const c of await listCollections()) push("collection", c.id, syncmeta.revOf("collection", c.id, c.createdAt), canonSig(c));
  for (const bm of await listBookmarks()) push("bookmark", bm.id, syncmeta.revOf("bookmark", bm.id, bm.createdAt), canonSig(bm));
  for (const [id, pos] of await positionsFolder.entries()) {
    if (!pos) continue;
    push("position", id, syncmeta.revOf("position", id, pos.updatedAt), canonSig(pos));
  }
  for (const t of syncmeta.tombstones()) {
    if (live.has(t.type + ":" + t.id)) continue;
    items.push({ type: t.type, id: t.id, rev: t.rev, del: true, sig: "" });
  }
  return items;
}

// The book's current text/cover fingerprints, cheaply when the record already
// carries them (putBook/putCover store them).
export async function syncBookHashes(id) {
  const meta = await getBook(id);
  if (!meta) return null;
  let textHash = meta.textHash || null;
  let coverHash = meta.coverHash || null;
  let dirty = false;
  if (!textHash) {
    const t = await getText(id);
    if (t != null) { textHash = textSig(t); meta.textHash = textHash; dirty = true; }
  }
  if (!coverHash && meta.coverLocal) {
    const c = await blobSig(await getCover(id));
    if (c) { coverHash = c; meta.coverHash = c; dirty = true; }
  }
  // Persist freshly-computed fingerprints (raw write: this is not an edit).
  if (dirty) { try { await libraryFolder.set(id, meta); } catch (e) {} }
  return { meta, textHash, coverHash };
}

// Read only what a peer asked for; absent blobs are reported as null so the
// receiver knows to drop its stale copy.
export async function syncReadBook(id, { text = false, cover = false } = {}) {
  const meta = await getBook(id);
  if (!meta) return null;
  const out = { meta };
  if (text) { try { out.text = (await getText(id)) ?? null; } catch (e) { out.text = null; } }
  if (cover) { try { out.cover = (await getCover(id)) ?? null; } catch (e) { out.cover = null; } }
  return out;
}

export async function syncReadRecord(type, id) {
  if (type === "collection") return getCollection(id);
  if (type === "bookmark") return getBookmark(id);
  if (type === "position") return getPosition(id);
  return null;
}

export async function syncApply(type, id, data, blobs = {}) {
  if (!data) return;
  if (type === "book") {
    const meta = { ...data };
    delete meta.chunks;
    await libraryFolder.set(id, meta);
    if ("text" in blobs) {
      if (blobs.text == null) { try { await textsFolder.delete(id); } catch (e) {} }
      else { try { await textsFolder.set(id, blobs.text); } catch (e) {} }
    }
    if ("cover" in blobs) {
      if (blobs.cover == null) { try { await coversFolder.delete(id); } catch (e) {} }
      else { try { await coversFolder.set(id, blobs.cover); } catch (e) {} }
    }
    // Keep fingerprints fresh if the sender's record predated hash storage.
    try {
      const b = await getBook(id);
      if (b && !b.textHash) { const t = await getText(id); if (t != null) { b.textHash = textSig(t); await libraryFolder.set(id, b); } }
      if (b && !b.coverHash && b.coverLocal) { const c = await getCover(id); if (c) { b.coverHash = await blobSig(c); await libraryFolder.set(id, b); } }
    } catch (e) {}
    return;
  }
  if (type === "collection") { await collectionsFolder.set(id, data); return; }
  if (type === "bookmark") { await bookmarksFolder.set(id, data); return; }
  if (type === "position") { await positionsFolder.set(id, data); return; }
}

export async function syncApplyDelete(type, id) {
  if (type === "book") {
    try { await libraryFolder.delete(id); } catch (e) {}
    try { await textsFolder.delete(id); } catch (e) {}
    try { await coversFolder.delete(id); } catch (e) {}
    try { await positionsFolder.delete(id); } catch (e) {}
    for (const bm of await listBookmarks()) {
      if (bm.bookId === id) { try { await bookmarksFolder.delete(bm.id); } catch (e) {} }
    }
    return;
  }
  if (type === "collection") {
    try { await collectionsFolder.delete(id); } catch (e) {}
    // Defensive: if the source's "lift children out" edits haven't arrived yet,
    // don't leave books pointing at a folder that no longer exists. A later
    // incoming record (with a higher revision) simply overwrites this.
    for (const b of await listLibrary()) {
      if ((b.collectionId ?? null) === id) { b.collectionId = null; try { await libraryFolder.set(b.id, b); } catch (e) {} }
    }
    for (const c of await listCollections()) {
      if ((c.parentId ?? null) === id) { c.parentId = null; try { await collectionsFolder.set(c.id, c); } catch (e) {} }
    }
    return;
  }
  if (type === "bookmark") { try { await bookmarksFolder.delete(id); } catch (e) {} return; }
  if (type === "position") { try { await positionsFolder.delete(id); } catch (e) {} return; }
}
