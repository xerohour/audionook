// ===========================================================================
// backup.js — export/import the whole local library as a .zip bundle.
//
// Audio is never included: a book is (text + voice), so the bundle only needs
// the prose, metadata, folder layout and playback positions. That keeps even a
// large library's backup tiny, because the audio is regenerated on demand.
//
// zip.js is loaded on demand (only when the user actually exports or imports),
// with web workers disabled so it works from a bundled CDN build without the
// cross-origin-worker restriction.
// ===========================================================================

import * as store from "./store.js";

const ZIP_URL = "https://esm.sh/@zip.js/zip.js@2.7.52";
export const BUNDLE_FORMAT = "audionook-library";
export const BUNDLE_VERSION = 1;

let zipMod = null;
async function zipLib() {
  if (!zipMod) {
    zipMod = await import(ZIP_URL);
    try { zipMod.configure({ useWebWorkers: false, useCompressionStream: true }); } catch (e) {}
  }
  return zipMod;
}

function byteSize(str) {
  try { return new Blob([str]).size; } catch (e) { return (str || "").length; }
}

// Read everything out of kv once; the export modal shows the estimate from this
// and reuses the same snapshot when the user actually exports.
export async function prepare({ includeArchived = false } = {}) {
  const data = await store.collectForBackup({ includeArchived });
  let bytes = 0;
  for (const t of Object.values(data.texts)) bytes += byteSize(t);
  for (const c of Object.values(data.covers || {})) bytes += (c && c.size) || 0;
  const metaJson = JSON.stringify({
    books: data.books, positions: data.positions, collections: data.collections, bookmarks: data.bookmarks || [],
  });
  bytes += byteSize(metaJson);
  bytes += 2048; // zip directory + bundle.json overhead
  return { data, bytes, bookCount: data.books.length, folderCount: data.collections.length };
}

export async function zipFromData(data, onProgress) {
  const { BlobWriter, BlobReader, TextReader, ZipWriter } = await zipLib();
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  const coverIds = Object.keys(data.covers || {});
  const entries = data.books.length + coverIds.length + 1;
  let done = 0;
  const step = () => { done++; if (onProgress) onProgress(done / entries); };
  await writer.add("bundle.json", new TextReader(JSON.stringify({
    app: BUNDLE_FORMAT,
    v: BUNDLE_VERSION,
    exportedAt: Date.now(),
    books: data.books,
    positions: data.positions,
    collections: data.collections,
    bookmarks: data.bookmarks || [],
  })));
  step();
  for (const b of data.books) {
    const text = data.texts[b.id];
    if (text == null) continue;
    await writer.add("texts/" + b.id + ".txt", new TextReader(text));
    step();
  }
  for (const id of coverIds) {
    await writer.add("covers/" + id + ".jpg", new BlobReader(data.covers[id]));
    step();
  }
  const blob = await writer.close();
  return { blob, bytes: blob.size };
}

export async function zipLibrary({ includeArchived = false } = {}, onProgress) {
  const { data } = await prepare({ includeArchived });
  return zipFromData(data, onProgress);
}

// --- importing --------------------------------------------------------------
export async function readBundle(file) {
  const { BlobReader, BlobWriter, TextWriter, ZipReader } = await zipLib();
  const reader = new ZipReader(new BlobReader(file));
  let bundle = null;
  const texts = {};
  const covers = {};
  try {
    const entries = await reader.getEntries();
    for (const entry of entries) {
      if (entry.directory) continue;
      if (entry.filename === "bundle.json") {
        bundle = JSON.parse(await entry.getData(new TextWriter()));
      } else if (entry.filename.startsWith("texts/") && entry.filename.endsWith(".txt")) {
        const id = entry.filename.slice("texts/".length, -".txt".length);
        texts[id] = await entry.getData(new TextWriter());
      } else if (entry.filename.startsWith("covers/") && entry.filename.endsWith(".jpg")) {
        const id = entry.filename.slice("covers/".length, -".jpg".length);
        covers[id] = await entry.getData(new BlobWriter("image/jpeg"));
      }
    }
  } finally {
    try { await reader.close(); } catch (e) {}
  }
  if (!bundle || typeof bundle !== "object") throw new Error("not a valid backup");
  if (bundle.app && bundle.app !== BUNDLE_FORMAT) throw new Error("that's a different app's backup");
  const books = Array.isArray(bundle.books) ? bundle.books : [];
  return {
    books,
    texts,
    covers,
    positions: bundle.positions && typeof bundle.positions === "object" ? bundle.positions : {},
    collections: Array.isArray(bundle.collections) ? bundle.collections : [],
    bookmarks: Array.isArray(bundle.bookmarks) ? bundle.bookmarks : [],
  };
}

export async function restoreBundle(file) {
  const parsed = await readBundle(file);
  const res = await store.importBundle(parsed, { overwrite: false });
  return { ...res, folders: parsed.collections.length };
}
