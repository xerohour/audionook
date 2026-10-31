// ===========================================================================
// syncmeta.js — revision bookkeeping for Device sync.
//
// Device sync needs a total order over "who changed this record last" without a
// central clock. We use a hybrid logical clock (HLC): every mutation stamps the
// record with `"<clockBase36>-<deviceId>"`, where `clock` is
// `max(Date.now(), lastClock + 1)`. Comparing two revisions (clock first, then
// device id) gives a deterministic last-writer-wins order that both devices
// agree on, even when their wall clocks disagree by a few seconds.
//
// A very small amount of metadata is kept per generator install:
//   revs  — { "book:<id>": "<rev>" }   the last local write to each live record
//   tombs — { "book:<id>": "<rev>" }   deletion tombstones (kept forever-ish)
// Records that were written before this module existed (or before the user
// linked a device) have no tracked rev; `seedRev(updatedAt)` derives one from
// the record's own timestamp so a first sync still orders sensibly.
//
// This file also owns the install's stable `deviceId` (shared with the sync
// protocol; also stored in the same "sync" folder).
// ===========================================================================

import * as storage from "./storage.js";

const folder = storage.folder("sync");
const META_KEY = "meta";
const ID_KEY = "deviceId";
const MAX_TOMBSTONES = 2000;

const TYPES = new Set(["book", "collection", "bookmark", "position"]);

let st = { clock: 0, revs: {}, tombs: {} };
let loaded = false;
let loading = null;
let queued = [];
let saveTimer = null;
let deviceId = "00000000";

const HEX = "0123456789abcdef";

function randomHex(nBytes) {
  const b = new Uint8Array(nBytes);
  try { crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < nBytes; i++) b[i] = Math.floor(Math.random() * 256); }
  let s = "";
  for (const x of b) s += HEX[x >> 4] + HEX[x & 15];
  return s;
}

export function getDeviceId() { return deviceId; }

// Load the persisted revision state + this install's device id. Safe to call
// repeatedly; mutations made before it resolves are queued and applied after.
export async function load() {
  if (loaded) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      let id = null;
      try { id = await folder.get(ID_KEY); } catch (e) {}
      if (id && typeof id === "string" && /^[0-9a-f]{8,32}$/.test(id)) deviceId = id;
      else { deviceId = randomHex(8); try { await folder.set(ID_KEY, deviceId); } catch (e) {} }

      const saved = await folder.get(META_KEY);
      if (saved && typeof saved === "object") {
        st.clock = Number(saved.clock) || 0;
        st.revs = saved.revs && typeof saved.revs === "object" ? saved.revs : {};
        st.tombs = saved.tombs && typeof saved.tombs === "object" ? saved.tombs : {};
      }
    } catch (e) {
      deviceId = randomHex(8);
    }
    loaded = true;
    const q = queued; queued = [];
    for (const fn of q) { try { fn(); } catch (e) {} }
  })();
  return loading;
}

export function isLoaded() { return loaded; }
export function observeReady(fn) { if (loaded) fn(); else queued.push(fn); }

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1500);
}

export async function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    await folder.set(META_KEY, { v: 1, clock: st.clock, revs: st.revs, tombs: st.tombs });
  } catch (e) { console.warn("sync meta save failed", e); }
}

// --- revisions --------------------------------------------------------------
export function parseRev(rev) {
  if (typeof rev !== "string") return null;
  const i = rev.indexOf("-");
  if (i <= 0) return null;
  const clock = parseInt(rev.slice(0, i), 36);
  if (!isFinite(clock)) return null;
  return { clock, device: rev.slice(i + 1) };
}

export function revCmp(a, b) {
  const pa = parseRev(a), pb = parseRev(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.clock !== pb.clock) return pa.clock < pb.clock ? -1 : 1;
  if (pa.device === pb.device) return 0;
  return pa.device < pb.device ? -1 : 1;
}

export function seedRev(ts) {
  const c = Math.max(0, Math.floor(Number(ts) || 0));
  return c.toString(36) + "-seed";
}

// The revision we hold for a live record. Falls back to a timestamp seed for
// records written before revision tracking (so their age still orders them).
export function revOf(type, id, ts) {
  const r = st.revs[type + ":" + id];
  return r || seedRev(ts);
}

export function tombOf(type, id) { return st.tombs[type + ":" + id] || null; }
export function isDeleted(type, id) { return !!st.tombs[type + ":" + id]; }
export function isTracked(type, id) { return !!st.revs[type + ":" + id]; }

function bump() {
  st.clock = Math.max(Date.now(), st.clock + 1);
  return st.clock.toString(36) + "-" + deviceId;
}

function pruneTombs() {
  const keys = Object.keys(st.tombs);
  if (keys.length <= MAX_TOMBSTONES) return;
  keys.sort((a, b) => revCmp(st.tombs[a], st.tombs[b]));
  for (let i = 0; i < keys.length - MAX_TOMBSTONES; i++) delete st.tombs[keys[i]];
}

// Record a local change (rev up, clear any tombstone).
export function markChanged(type, id) {
  if (!TYPES.has(type) || id == null) return;
  observeReady(() => {
    const key = type + ":" + id;
    const rev = bump();
    st.revs[key] = rev;
    if (st.tombs[key]) delete st.tombs[key];
    scheduleSave();
  });
}

// Record a local deletion.
export function markDeleted(type, id) {
  if (!TYPES.has(type) || id == null) return;
  observeReady(() => {
    const key = type + ":" + id;
    const rev = bump();
    st.tombs[key] = rev;
    delete st.revs[key];
    pruneTombs();
    scheduleSave();
  });
}

// Adopt a revision learned from a peer (does not touch records).
export function setRev(type, id, rev, deleted) {
  if (!TYPES.has(type) || id == null || typeof rev !== "string") return;
  observeReady(() => {
    const key = type + ":" + id;
    const p = parseRev(rev);
    if (p && p.clock > st.clock) st.clock = p.clock;
    if (deleted) { st.tombs[key] = rev; delete st.revs[key]; pruneTombs(); }
    else { st.revs[key] = rev; if (st.tombs[key]) delete st.tombs[key]; }
    scheduleSave();
  });
}

// All live tombstones, for building a manifest.
export function tombstones() {
  const out = [];
  for (const key of Object.keys(st.tombs)) {
    const i = key.indexOf(":");
    const type = key.slice(0, i), id = key.slice(i + 1);
    if (!TYPES.has(type)) continue;
    out.push({ type, id, rev: st.tombs[key] });
  }
  return out;
}

export function debugState() {
  return { deviceId, clock: st.clock, revs: Object.keys(st.revs).length, tombs: Object.keys(st.tombs).length };
}
