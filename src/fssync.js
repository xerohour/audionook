// ===========================================================================
// fssync.js — mirror the whole library into a folder the user picks on their
// own disk, using the File System Access API.
//
// This is the strongest backup the app can offer: the library is written as a
// real .zip the user can keep, copy, or open anywhere, and it survives clearing
// the browser's storage entirely. The chosen directory handle is persisted in
// IndexedDB (the only place a live handle can be stored) so a returning user
// can sync again with a single click — the browser still re-asks for write
// permission, which is fine because it happens inside the click.
//
// Everything here degrades gracefully: if the API is missing (Firefox/Safari)
// `isSupported()` is false. If the embedded context forbids the picker — which
// is the normal case on Perchance — `isAvailable()` is false and the UI simply
// doesn't offer the button (see `pickerAllowed`).
// ===========================================================================

import * as backup from "./backup.js";

const IDB_NAME = "audionook-fs";
const STORE = "handles";
const HANDLE_KEY = "libraryDir";
const FILE_NAME = "audionook-library.zip";

export function isSupported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

// The File System Access spec (https://wicg.github.io/file-system-access/ §3.1,
// "is allowed to show a file picker") only lets a picker open when the document's
// origin is *same-origin with the top-level origin* (plus transient activation).
// A cross-origin subframe is therefore refused — and that is exactly how Perchance
// serves a generator: the code runs in a `<name>.<publicId>.perchance.org` iframe
// inside `perchance.org`, so the picker can never open there.
//
// There is no query API for this: the check is an internal algorithm and is NOT a
// permissions-policy feature we can introspect (`document.featurePolicy.features()`
// has no "file-system-access" entry, and `navigator.permissions.query` has no
// matching descriptor). So we infer it from the frame context: reading the *top*
// window's location succeeds only when we are same-origin with it. Opaque origins
// are refused by the spec too.
function pickerAllowed() {
  if (!isSupported() || !window.isSecureContext) return false;
  const origin = window.location.origin;
  if (!origin || origin === "null") return false;
  try { return window.top.location.origin === origin; }
  catch (e) { return false; }
}

// Whether the picker may actually be shown *here*. The UI gates the whole
// local-folder module on this so a cross-origin embed shows nothing rather than a
// button that always fails (which users would read as a device problem).
export function isAvailable() {
  return pickerAllowed();
}

// --- tiny IndexedDB wrapper (handle persistence only) -----------------------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDo(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      const req = fn(store);
      if (req) req.onsuccess = () => { result = req.result; };
    } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export async function getHandle() {
  try { return (await idbDo("readonly", (s) => s.get(HANDLE_KEY))) || null; }
  catch (e) { return null; }
}

async function setHandle(handle) {
  try { await idbDo("readwrite", (s) => s.put(handle, HANDLE_KEY)); } catch (e) {}
}

export async function forgetHandle() {
  try { await idbDo("readwrite", (s) => s.delete(HANDLE_KEY)); } catch (e) {}
}

// --- permissions ------------------------------------------------------------
async function hasPermission(handle, request = false) {
  if (!handle || typeof handle.queryPermission !== "function") return true;
  const opts = { mode: "readwrite" };
  try {
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if (!request) return false;
    return (await handle.requestPermission(opts)) === "granted";
  } catch (e) {
    return false;
  }
}

// Must be called from a user gesture.
export async function chooseFolder() {
  if (!isAvailable()) throw new Error("blocked");
  const handle = await window.showDirectoryPicker({ id: "audionook-library", mode: "readwrite", startIn: "documents" });
  if (!(await hasPermission(handle, true))) throw new Error("permission");
  await setHandle(handle);
  return handle;
}

export async function describe() {
  const handle = await getHandle();
  if (!handle) return null;
  return { name: handle.name || "folder", granted: await hasPermission(handle, false) };
}

// Write the current library into the synced folder. Returns { name, bytes, at }.
// `force` re-requests permission (only legal inside a user gesture).
export async function syncNow({ includeArchived = false, force = false } = {}) {
  const handle = await getHandle();
  if (!handle) throw new Error("no-folder");
  if (!(await hasPermission(handle, force))) throw new Error("permission");
  const { data } = await backup.prepare({ includeArchived });
  const { blob } = await backup.zipFromData(data);
  const fileHandle = await handle.getFileHandle(FILE_NAME, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return { name: handle.name || "folder", bytes: blob.size, at: Date.now(), file: FILE_NAME, bookCount: data.books.length };
}

export { FILE_NAME };
