// ===========================================================================
// storage.js — the app's key/value persistence layer.
//
// Everything the app saves (library metadata, prose, playback positions,
// bookmarks, the synthesised-audio cache, …) goes through a folder object here.
// When the browser supports the Origin Private File System (OPFS) the data is
// written to real files inside the origin's private file system — that is the
// preferred backend, because it is fast, can hold multi-gigabyte blobs, and is
// visible to storage management. On browsers without OPFS we fall back to the
// kv-plugin (IndexedDB), which exposes the same tiny API.
//
// A folder is a namespace of string keys. Values may be JSON-able data (objects,
// arrays, strings, numbers, booleans) or binary (Blob / ArrayBuffer / typed
// array). Binary values are stored byte-for-byte; JSON values are serialised.
// Each record is one file whose first line is a small JSON header carrying the
// original key (so `keys()`/`entries()` can round-trip any key, however long —
// e.g. a full URL) and the value kind.
// ===========================================================================

import { contentHash } from "./util.js";

const DIR_NAME = "store";
let mode = null;          // "opfs" | "kv"
let initPromise = null;
let opfsRoot = null;
const dirCache = new Map();

function canUseOpfs() {
  return typeof navigator !== "undefined"
    && !!navigator.storage
    && typeof navigator.storage.getDirectory === "function";
}

// Probe the backend once. Resolves to "opfs" or "kv"; never rejects.
export async function init() {
  if (mode) return mode;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!canUseOpfs()) { mode = "kv"; return mode; }
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIR_NAME, { create: true });
      // Confirm we can actually write before committing to OPFS.
      const probe = await dir.getFileHandle(".ok", { create: true });
      const w = await probe.createWritable();
      await w.write(new Uint8Array([1]));
      await w.close();
      await dir.removeEntry(".ok");
      opfsRoot = root;
      mode = "opfs";
    } catch (e) {
      mode = "kv";
    }
    return mode;
  })();
  return initPromise;
}

export function backend() { return mode; }
export function backendLabel() {
  return mode === "opfs" ? "On-device file system (OPFS)" : "Browser database";
}

// --- record encoding --------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();

function isBinary(v) {
  return (typeof Blob !== "undefined" && v instanceof Blob)
    || v instanceof ArrayBuffer
    || ArrayBuffer.isView(v);
}

async function toBytes(v) {
  if (typeof Blob !== "undefined" && v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

async function encodeValue(key, value) {
  let header, payload;
  if (isBinary(value)) {
    header = enc.encode(JSON.stringify({ k: key, t: "b", ct: (value && value.type) || "application/octet-stream" }) + "\n");
    payload = await toBytes(value);
  } else {
    header = enc.encode(JSON.stringify({ k: key, t: "j" }) + "\n");
    payload = enc.encode(JSON.stringify(value === undefined ? null : value));
  }
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

function readContainer(bytes) {
  let nl = -1;
  const scan = Math.min(bytes.length, 8192);
  for (let i = 0; i < scan; i++) { if (bytes[i] === 10) { nl = i; break; } }
  if (nl < 0) return null;
  let header;
  try { header = JSON.parse(dec.decode(bytes.subarray(0, nl))); } catch (e) { return null; }
  if (!header || typeof header.k !== "string") return null;
  const payload = bytes.subarray(nl + 1);
  let v;
  if (header.t === "b") v = new Blob([payload], { type: header.ct || "application/octet-stream" });
  else { try { v = JSON.parse(dec.decode(payload)); } catch (e) { v = null; } }
  return { k: header.k, v };
}

// Deterministic, collision-resistant filename for a key. The key itself lives
// inside the file header, so the filename only needs to be unique and stable.
function fileName(key) {
  const { a, b } = contentHash(String(key));
  return "h" + a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0") + ".dat";
}

// --- OPFS backend -----------------------------------------------------------
async function dirHandle(name) {
  await init();
  if (mode !== "opfs") return null;
  if (dirCache.has(name)) return dirCache.get(name);
  const root = opfsRoot || (opfsRoot = await navigator.storage.getDirectory());
  const h = await root.getDirectoryHandle(name, { create: true });
  dirCache.set(name, h);
  return h;
}

function opfsFolder(name) {
  return {
    async get(key) {
      try {
        const d = await dirHandle(name);
        if (!d) return undefined;
        const fh = await d.getFileHandle(fileName(key));
        const f = await fh.getFile();
        const rec = readContainer(new Uint8Array(await f.arrayBuffer()));
        return rec ? rec.v : undefined;
      } catch (e) { return undefined; }
    },
    async set(key, value) {
      const d = await dirHandle(name);
      const fh = await d.getFileHandle(fileName(key), { create: true });
      const w = await fh.createWritable();
      await w.write(await encodeValue(key, value));
      await w.close();
      return value;
    },
    async delete(key) {
      try {
        const d = await dirHandle(name);
        if (d) await d.removeEntry(fileName(key));
      } catch (e) {}
    },
    async keys() {
      const out = [];
      try {
        const d = await dirHandle(name);
        for await (const [n, h] of d.entries()) {
          if (h.kind !== "file" || !n.endsWith(".dat")) continue;
          const rec = readContainer(new Uint8Array(await (await h.getFile()).arrayBuffer()));
          if (rec) out.push(rec.k);
        }
      } catch (e) {}
      return out;
    },
    async entries() {
      const out = [];
      try {
        const d = await dirHandle(name);
        for await (const [n, h] of d.entries()) {
          if (h.kind !== "file" || !n.endsWith(".dat")) continue;
          const rec = readContainer(new Uint8Array(await (await h.getFile()).arrayBuffer()));
          if (rec) out.push([rec.k, rec.v]);
        }
      } catch (e) {}
      return out;
    },
    async clear() {
      try {
        await init();
        if (mode !== "opfs") return;
        const root = opfsRoot || (opfsRoot = await navigator.storage.getDirectory());
        await root.removeEntry(name, { recursive: true });
        dirCache.delete(name);
      } catch (e) {}
    },
  };
}

// --- kv fallback backend ----------------------------------------------------
function kvFolder(name) {
  const folder = () => root.kv[name];
  return {
    async get(key) { try { return await folder().get(key); } catch (e) { return undefined; } },
    async set(key, value) { await folder().set(key, value); return value; },
    async delete(key) { try { await folder().delete(key); } catch (e) {} },
    async keys() { try { return await folder().keys(); } catch (e) { return []; } },
    async entries() { try { return await folder().entries(); } catch (e) { return []; } },
    async clear() {
      try {
        for (const k of await this.keys()) await this.delete(k);
      } catch (e) {}
    },
  };
}

async function pick(name) {
  await init();
  return mode === "opfs" ? opfsFolder(name) : kvFolder(name);
}

// A folder is a handle to one namespace; methods resolve the backend on demand
// so callers never need to await `init()` themselves.
export function folder(name) {
  return {
    get: async (key) => (await pick(name)).get(key),
    set: async (key, value) => (await pick(name)).set(key, value),
    delete: async (key) => (await pick(name)).delete(key),
    keys: async () => (await pick(name)).keys(),
    entries: async () => (await pick(name)).entries(),
    clear: async () => (await pick(name)).clear(),
    getMany: async (keys) => {
      const b = await pick(name);
      const out = [];
      for (const k of keys) out.push([k, await b.get(k)]);
      return out;
    },
    setMany: async (pairs) => {
      const b = await pick(name);
      for (const [k, v] of pairs) await b.set(k, v);
    },
    update: async (key, fn) => {
      const b = await pick(name);
      const cur = await b.get(key);
      const next = await fn(cur);
      await b.set(key, next);
      return next;
    },
  };
}
