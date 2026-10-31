// ===========================================================================
// devicesync.js — "Device sync": keep a library in step across a user's devices.
//
// How it works, end to end:
//
//   1. Pairing. A device mints 32 random bytes (the *group secret*) and shows a
//      link `?sync=<secret>`. Opening that link on another device stores the
//      same secret there. The secret never leaves the devices.
//
//   2. Coordination (tiny, server-side). A device derives a room id from the
//      secret (`SHA-256(secret)`) and joins it on the `server-plugin`. The
//      server keeps only an ephemeral in-memory list of connections in that
//      room and relays small, end-to-end-encrypted control frames between them.
//      It never writes durable state and it can't read any payload. This is the
//      whole server cost per sync: a handful of small messages.
//
//   3. Bulk transfer (big data). Everything else — book prose, cover images —
//      travels peer-to-peer over a WebRTC DataChannel. If a direct connection
//      can't be made quickly, the same frames are AES-GCM encrypted and pushed
//      through the upload service as short-lived files instead (the coordination
//      socket only ever carries the URL, never the bytes).
//
//   4. Merge policy. Records carry a hybrid-logical-clock revision
//      ("<clockBase36>-<deviceId>", see syncmeta.js). Each side sends a small
//      manifest (ids + revisions + hashes) and the winner is the newer revision
//      (ties broken by content signature). Deletions are revisions too, held as
//      tombstones, so a delete on one device propagates; a *newer* edit on the
//      other device resurrects the record. This is whole-record last-writer-wins
//      over a small, explicitly-enumerated set of record types — the same shape
//      popular local-first sync engines use.
//
// Scope: books (metadata + prose + cover), folders, bookmarks and playback
// positions. Settings, drafts and the synthesised-audio cache stay device-local.
// ===========================================================================

import { sleep } from "./util.js";
import * as storage from "./storage.js";
import * as store from "./store.js";
import * as syncmeta from "./syncmeta.js";

const US = "\u001f";       // field separator on the coordination wire
const RS = "\u001e";       // row separator (members list)
const SECRET_BYTES = 32;
const CHUNK = 18000;       // chars per relayed control-frame chunk
const DC_CHUNK = 16000;    // chars per DataChannel chunk
const RELAY_DELAY = 8000;  // ms to give WebRTC before falling back to uploads
const SESSION_TIMEOUT = 90000;
const AUTO_BEGIN_DELAY = 700;
const ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

// --- on-demand chunk sharing ------------------------------------------------
// The audio cache is far too large to keep in step (a whole book is hundreds of
// MB), so it is shared strictly on demand: when the local engine needs a chunk
// it hasn't cached, it asks a connected peer for that one key. Requests are a
// tiny list of cache keys over the encrypted control channel; only a *hit's*
// audio bytes are ever sent in bulk (WebRTC, or a short-lived upload as the
// fallback). A miss costs one small control frame. If peers keep missing, the
// broker backs off so a device with a big library doesn't pay a round trip per
// chunk against a peer that doesn't have the book.
const CHUNK_BATCH_MAX = 12;      // cache keys per request
const CHUNK_KEY_MAX = 700;       // reject absurd cache keys
const CHUNK_BATCH_DELAY = 30;    // ms to gather keys before flushing
const CHUNK_REQ_TIMEOUT = 8000;  // give a peer this long to answer a batch (direct link)
const CHUNK_RELAY_TIMEOUT = 22000; // ...and this long when only the upload relay is available
const CHUNK_ABS_TIMEOUT = 30000; // absolute per-key bound, whatever the transport
const CHUNK_PEER_WAIT = 1500;    // wait this long for a peer to appear
const CHUNK_IDLE_MS = 60000;     // keep the socket open this long after a fetch
const CHUNK_MISS_LIMIT = 24;     // consecutive misses before backing off
const CHUNK_BACKOFF_MS = 60000;
const DISCONNECT_GRACE = 6000;   // linger this long after the last reason to stay connected

// The audio-cache accessors, injected from app.js (engine.js owns the cache).
let chunkStore = null;
export function setChunkStore(s) { chunkStore = (s && typeof s.get === "function") ? s : null; }

// --- little helpers ---------------------------------------------------------
const B64CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64LUT = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < B64CH.length; i++) t[B64CH.charCodeAt(i)] = i; return t; })();

function b64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8) | (i + 2 < b.length ? b[i + 2] : 0);
    s += B64CH[(n >> 18) & 63] + B64CH[(n >> 12) & 63]
      + (i + 1 < b.length ? B64CH[(n >> 6) & 63] : "")
      + (i + 2 < b.length ? B64CH[n & 63] : "");
  }
  return s;
}
function unb64url(str) {
  const out = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const v = c < 128 ? B64LUT[c] : -1;
    if (v < 0) continue;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); }
  }
  return new Uint8Array(out);
}
function splitString(s, n) { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; }
function randId() {
  const b = new Uint8Array(6);
  try { crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < 6; i++) b[i] = Math.floor(Math.random() * 256); }
  let s = "";
  for (const x of b) s += (x >> 4).toString(16) + (x & 15).toString(16);
  return s;
}
function randomSecret() {
  const b = new Uint8Array(SECRET_BYTES);
  try { crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }
  return b;
}

function deviceName() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  let os = "device";
  if (/iPhone/i.test(ua)) os = "iPhone";
  else if (/iPad/i.test(ua)) os = "iPad";
  else if (/Android/i.test(ua)) os = "Android device";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "Mac";
  else if (/Windows/i.test(ua)) os = "PC";
  else if (/CrOS/i.test(ua)) os = "Chromebook";
  else if (/Linux/i.test(ua)) os = "Linux";
  let br = "Browser";
  if (/Edg\//.test(ua)) br = "Edge";
  else if (/OPR\//.test(ua)) br = "Opera";
  else if (/Firefox\//.test(ua)) br = "Firefox";
  else if (/Chrome\//.test(ua)) br = "Chrome";
  else if (/Safari\//.test(ua)) br = "Safari";
  return br + " on " + os;
}

// --- crypto -----------------------------------------------------------------
const SALT = new TextEncoder().encode("audionook-sync-v2");
const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  const b = new Uint8Array(d);
  let s = "";
  for (const x of b) s += (x >> 4).toString(16) + (x & 15).toString(16);
  return s;
}
async function deriveKey(secretBytes, info) {
  const base = await crypto.subtle.importKey("raw", secretBytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: enc.encode(info) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}
async function packBytes(key, str) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(str)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0); out.set(ct, iv.length);
  return out;
}
async function unpackBytes(key, bytes) {
  const iv = bytes.subarray(0, 12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, bytes.subarray(12));
  return dec.decode(pt);
}

// --- stored identity --------------------------------------------------------
const folder = storage.folder("sync");
const IDENTITY_KEY = "identity";

async function loadStoredIdentity() {
  let rec = null;
  try { rec = await folder.get(IDENTITY_KEY); } catch (e) {}
  if (!rec || typeof rec !== "object" || typeof rec.s !== "string") return null;
  const bytes = unb64url(rec.s);
  if (!bytes || bytes.length !== SECRET_BYTES) return null;
  return { secretBytes: bytes, name: rec.n || deviceName(), at: rec.at || 0 };
}
async function saveStoredIdentity(secretBytes, name) {
  try { await folder.set(IDENTITY_KEY, { s: secretBytes ? b64url(secretBytes) : "", n: name, at: Date.now() }); } catch (e) {}
}

// --- default IO adapter (real app storage) ----------------------------------
const nowPlaying = { get: () => null };
export function setNowPlaying(getter) { nowPlaying.get = typeof getter === "function" ? getter : () => null; }

const defaultIO = {
  manifest: () => store.syncManifest(),
  bookHashes: (id) => store.syncBookHashes(id),
  readBook: (id, opt) => store.syncReadBook(id, opt),
  readRecord: (type, id) => store.syncReadRecord(type, id),
  apply: async (type, id, data, blobs) => {
    // Never stomp the position of the book being listened to right now — the
    // user's live progress will win the next time it's saved.
    if (type === "position") {
      try { if (nowPlaying.get() === id) return; } catch (e) {}
    }
    return store.syncApply(type, id, data, blobs);
  },
  applyDelete: (type, id) => store.syncApplyDelete(type, id),
  setRev: (type, id, rev, deleted) => syncmeta.setRev(type, id, rev, deleted),
  revCmp: (a, b) => syncmeta.revCmp(a, b),
};

// --- the coordination socket ------------------------------------------------
class Coordinator {
  constructor({ roomId, deviceId, name, keys, onFrame, onPeer, onPeerGone, onStatus }) {
    this.roomId = roomId;
    this.deviceId = deviceId;
    this.name = name;
    this.keys = keys;
    this.onFrame = onFrame;
    this.onPeer = onPeer;
    this.onPeerGone = onPeerGone;
    this.onStatus = onStatus;
    this.socket = null;
    this.closed = false;
    this._chunks = new Map();
  }

  async connect() {
    const socket = root.createServerSocket();
    this.socket = socket;
    socket.addEventListener("message", (ev) => this._onMessage(ev.data));
    socket.addEventListener("close", () => {
      if (this.closed) return;
      this.closed = true;
      if (this.onStatus) this.onStatus("offline");
    });
    await socket.opened;
    const res = String(await socket.rpc.sync_join(this.roomId + US + this.deviceId + US + this.name));
    if (res.startsWith("err")) throw new Error(res.split(US)[1] || "join_failed");
    const rows = res.length > 2 ? res.slice(2).split(RS) : [];
    for (const row of rows) {
      if (!row) continue;
      const [id, name] = row.split(US);
      if (id && id !== this.deviceId) this.onPeer(id, name || "");
    }
    return this;
  }

  _onMessage(data) {
    if (this.closed || typeof data !== "string") return;
    const i1 = data.indexOf(US);
    if (i1 < 0) return;
    const kind = data.slice(0, i1);
    if (kind === "ev") {
      const parts = data.slice(i1 + 1).split(US);
      const op = parts[0], deviceId = parts[1], name = parts[2] || "";
      if (!deviceId || deviceId === this.deviceId) return;
      if (op === "join") this.onPeer(deviceId, name);
      else if (op === "leave") this.onPeerGone(deviceId);
      return;
    }
    if (kind !== "msg") return;
    const rest = data.slice(i1 + 1);
    const j = rest.indexOf(US);
    if (j < 0) return;
    const from = rest.slice(0, j);
    const payload = rest.slice(j + 1);
    this._consume(from, payload);
  }

  async _consume(from, payload) {
    const p1 = payload.indexOf(US);
    if (p1 < 0) return;
    const id = payload.slice(0, p1);
    const rest = payload.slice(p1 + 1);
    const p2 = rest.indexOf(US);
    if (p2 < 0) return;
    const idx = parseInt(rest.slice(0, p2), 10);
    const rest2 = rest.slice(p2 + 1);
    const p3 = rest2.indexOf(US);
    if (p3 < 0) return;
    const total = parseInt(rest2.slice(0, p3), 10);
    const piece = rest2.slice(p3 + 1);
    let e = this._chunks.get(id);
    if (!e) { e = { total, parts: new Array(total), got: 0, at: Date.now() }; this._chunks.set(id, e); }
    if (e.parts[idx] === undefined) { e.parts[idx] = piece; e.got++; }
    if (this._chunks.size > 32) {
      const now = Date.now();
      for (const [k, v] of this._chunks) if (now - v.at > 60000) this._chunks.delete(k);
    }
    if (e.got < e.total) return;
    this._chunks.delete(id);
    try {
      const json = await unpackBytes(this.keys.ctl, unb64url(e.parts.join("")));
      this.onFrame(from, JSON.parse(json));
    } catch (err) { console.warn("sync frame decode failed", err); }
  }

  async send(toDeviceId, obj) {
    if (this.closed || !this.socket) throw new Error("offline");
    const env = b64url(await packBytes(this.keys.ctl, JSON.stringify(obj)));
    const pieces = splitString(env, CHUNK);
    const id = randId();
    for (let i = 0; i < pieces.length; i++) {
      const payload = id + US + i + US + pieces.length + US + pieces[i];
      const res = String(await this.socket.rpc.sync_send(this.roomId + US + toDeviceId + US + payload));
      if (res.startsWith("err")) throw new Error(res.split(US)[1] || "send_failed");
    }
  }

  close() {
    this.closed = true;
    if (this.socket) { try { this.socket.close(1000, "done"); } catch (e) {} }
    this.socket = null;
  }
}

// --- one peer: transport (WebRTC / relay) + the sync session ----------------
class Peer {
  constructor(engine, deviceId, name) {
    this.engine = engine;
    this.id = deviceId;
    this.name = name || "Device";
    this.started = false;
    this.closed = false;
    this.sid = null;
    this.relayAt = 0;
    this._ctlQ = Promise.resolve();
    this._bulkQ = Promise.resolve();
    this._dcChunks = new Map();
    this.relayUploads = new Map();
    this._initSession();
  }

  _isLeader() { return this.engine.deviceId < this.id; }

  _initSession() {
    this.myByKey = new Map();
    this.peerByKey = new Map();
    this.peerManifest = null;
    this.wantSent = false;
    this.peerSent = false;
    this.expected = 0;
    this.applied = 0;
    this.doneSent = false;
    this.doneReceived = false;
    this.finished = false;
    this.stats = { sent: 0, recv: 0, deletes: 0, error: null };
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
  }

  _ctl(obj) {
    const run = async () => {
      const c = this.engine.coord;
      if (!c || c.closed) throw new Error("offline");
      await c.send(this.id, obj);
    };
    this._ctlQ = this._ctlQ.then(run, run);
    return this._ctlQ;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.relayAt = Date.now() + RELAY_DELAY;
    this._initWebrtc(this._isLeader());
    try { await this._ctl({ t: "hello", v: 2, id: this.engine.deviceId, n: this.engine.name }); } catch (e) {}
    this.notify();
    // Only auto-run a session when the user actually opened the sync UI; a
    // background/presence connection (see setPresence) just idles until asked,
    // so linking doesn't silently push the library around on every launch.
    if (this._isLeader() && this.engine.active) {
      setTimeout(() => {
        if (!this.closed && !this.finished && !this.sid) this.beginSession();
      }, AUTO_BEGIN_DELAY);
    }
  }

  // ---- session lifecycle ---------------------------------------------------
  beginSession() {
    if (this.closed) return;
    const sid = randId();
    this._initSession();
    this.sid = sid;
    this.engine._sessionBusy = true;
    this._ctl({ t: "begin", sid, id: this.engine.deviceId, n: this.engine.name }).catch(() => {});
    this._runManifest();
    this.notify();
  }

  _adoptSession(sid) {
    this._initSession();
    this.sid = sid;
    this.engine._sessionBusy = true;
  }

  async _runManifest() {
    const sid = this.sid;
    this._timeout = setTimeout(() => this._forceFinish(), SESSION_TIMEOUT);
    let items = [];
    try {
      items = await this.engine.io.manifest();
      this.myByKey = new Map(items.map((it) => [it.type + ":" + it.id, it]));
    } catch (e) { console.warn("sync manifest failed", e); this.stats.error = "manifest"; }
    if (this.closed || this.sid !== sid || this.finished) return;
    try { await this._ctl({ t: "manifest", sid, items }); } catch (e) { this.stats.error = "offline"; }
    this.notify();
  }

  handle(obj) {
    if (!obj || typeof obj !== "object" || this.closed) return;
    switch (obj.t) {
      case "hello":
        if (obj.n) this.name = obj.n;
        this.notify();
        return;
      case "begin":
        this._adoptSession(obj.sid || randId());
        this._runManifest();
        this.notify();
        return;
      case "request":
        if (this._isLeader() && (!this.sid || this.finished)) this.beginSession();
        return;
      case "sig": this._signal(obj.d); return;
      case "relay": this._onRelay(obj); return;
      case "relay_ack": this._onRelayAck(obj); return;
      case "chreq": this._onChunkReq(obj); return;
      // A peer's "I don't hold that" reply — session-independent like chreq, and
      // it must settle the request at once rather than waiting out the timer.
      case "chno": this.engine._onChunkResponse(this.id, obj); return;
    }
    if (obj.sid !== this.sid) return;   // stale frame from an old session
    switch (obj.t) {
      case "manifest": this._onManifest(obj.items || []); return;
      case "want": this._onWant(obj.items || []); return;
      case "rec": this._onRec(obj); return;
      case "book": this._onBook(obj); return;
      case "sent": this._onSent(obj); return;
      case "done": this._onDone(); return;
      default: return;
    }
  }

  async _onManifest(items) {
    if (this.peerManifest) return;
    this.peerManifest = items;
    this.peerByKey = new Map(items.map((it) => [it.type + ":" + it.id, it]));
    const wants = [];
    for (const it of items) {
      const mine = this.myByKey.get(it.type + ":" + it.id);
      const v = this._verdict(it, mine);
      if (v !== "theirs") continue;
      if (it.del) {
        try {
          await this.engine.io.applyDelete(it.type, it.id);
          this.engine.io.setRev(it.type, it.id, it.rev, true);
          this.stats.deletes++;
        } catch (e) { console.warn("apply delete failed", e); }
      } else {
        wants.push({ y: it.type, i: it.id, b: this._blobsWanted(it, mine) });
      }
    }
    this.wantSent = true;
    try { await this._ctl({ t: "want", sid: this.sid, items: wants }); } catch (e) { this.stats.error = "offline"; }
    this.notify();
    this._maybeFinish();
  }

  _verdict(theirs, mine) {
    if (!mine) return theirs.del ? "same" : "theirs";
    if (mine.del && theirs.del) return "same";
    const c = this.engine.io.revCmp(theirs.rev, mine.rev);
    if (c > 0) return "theirs";
    if (c < 0) return "mine";
    const ts = theirs.del ? "" : (theirs.sig || "");
    const ms = mine.del ? "" : (mine.sig || "");
    if (ts === ms) return "same";
    return ts > ms ? "theirs" : "mine";
  }

  _blobsWanted(peerItem, mineItem) {
    if (!mineItem) return ["text", "cover"];
    const out = [];
    if (peerItem.th && peerItem.th !== mineItem.th) out.push("text");
    if (peerItem.ch && peerItem.ch !== mineItem.ch) out.push("cover");
    return out;
  }

  async _onWant(items) {
    const sid = this.sid;
    let n = 0;
    for (const w of items) {
      if (this.closed || this.sid !== sid) return;
      try {
        if (w.y === "book") {
          const want = Array.isArray(w.b) ? w.b : [];
          const payload = await this.engine.io.readBook(w.i, { text: want.includes("text"), cover: want.includes("cover") });
          if (!payload) continue;
          const frame = { t: "book", sid, i: w.i, m: payload.meta };
          if ("text" in payload) frame.text = payload.text;
          if ("cover" in payload) {
            frame.cover = payload.cover
              ? { d: b64url(new Uint8Array(await payload.cover.arrayBuffer())), m: payload.cover.type || "image/jpeg" }
              : null;
          }
          await this.sendBulk(frame);
          n++;
        } else {
          const data = await this.engine.io.readRecord(w.y, w.i);
          if (data === null || data === undefined) continue;
          await this._ctl({ t: "rec", sid, y: w.y, i: w.i, d: data });
          n++;
        }
      } catch (e) { console.warn("sync send item failed", w, e); this.stats.error = "transfer"; }
    }
    this.stats.sent += n;
    if (this.sid !== sid || this.closed) return;
    try { await this._ctl({ t: "sent", sid, n }); } catch (e) {}
    this.notify();
    this._maybeFinish();
  }

  _peerRev(type, id) {
    const it = this.peerByKey.get(type + ":" + id);
    return it ? it.rev : null;
  }

  async _onRec(obj) {
    try {
      await this.engine.io.apply(obj.y, obj.i, obj.d, {});
      const rev = this._peerRev(obj.y, obj.i);
      if (rev) this.engine.io.setRev(obj.y, obj.i, rev, false);
      this.applied++;
      this.stats.recv++;
    } catch (e) { console.warn("apply record failed", e); this.stats.error = "apply"; }
    this.notify();
    this._maybeFinish();
  }

  async _onBook(obj) {
    try {
      const blobs = {};
      if ("text" in obj) blobs.text = obj.text;
      if ("cover" in obj) blobs.cover = obj.cover ? new Blob([unb64url(obj.cover.d)], { type: obj.cover.m || "image/jpeg" }) : null;
      await this.engine.io.apply("book", obj.i, obj.m, blobs);
      const rev = this._peerRev("book", obj.i);
      if (rev) this.engine.io.setRev("book", obj.i, rev, false);
      this.applied++;
      this.stats.recv++;
    } catch (e) { console.warn("apply book failed", e); this.stats.error = "apply"; }
    this.notify();
    this._maybeFinish();
  }

  _onSent(obj) {
    this.peerSent = true;
    this.expected = Math.max(0, obj.n | 0);
    this._maybeFinish();
  }

  _onDone() {
    this.doneReceived = true;
    this._maybeFinish();
    this._checkFinished();
  }

  _maybeFinish() {
    if (this.doneSent || this.closed || !this.sid) return;
    if (!this.wantSent || !this.peerSent) return;
    if (this.applied < this.expected) return;
    this.doneSent = true;
    this._ctl({ t: "done", sid: this.sid }).catch(() => {});
    this._checkFinished();
  }

  _checkFinished() {
    if (this.finished) return;
    if (this.doneSent && this.doneReceived) {
      this.finished = true;
      if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
      this.engine._peerFinished(this);
    }
  }

  _forceFinish() {
    if (this.finished) return;
    this.finished = true;
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    this._ctl({ t: "done", sid: this.sid }).catch(() => {});
    this.engine._peerFinished(this);
  }

  // ---- WebRTC --------------------------------------------------------------
  _initWebrtc(initiator) {
    if (typeof RTCPeerConnection !== "function") { this.relayAt = Date.now(); return; }
    this._initiator = !!initiator;
    try { this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); }
    catch (e) { this.relayAt = Date.now(); return; }
    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
      this._ctl({ t: "sig", d: { kind: "ice", c } }).catch(() => {});
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc && this.pc.connectionState;
      if (s === "failed" || s === "closed") this.relayAt = Date.now();
    };
    if (this._initiator) {
      try { this.dc = this.pc.createDataChannel("sync", { ordered: true }); this._bindDc(); }
      catch (e) { this.relayAt = Date.now(); }
      this._negotiate();
    } else {
      this.pc.ondatachannel = (e) => { this.dc = e.channel; this._bindDc(); };
    }
  }

  async _negotiate() {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this._ctl({ t: "sig", d: { kind: "offer", sdp: this.pc.localDescription.sdp } });
    } catch (e) { this.relayAt = Date.now(); }
  }

  async _signal(d) {
    if (!d || typeof d !== "object") return;
    try {
      if (d.kind === "offer") {
        if (!this.pc) this._initWebrtc(false);
        await this.pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
        const ans = await this.pc.createAnswer();
        await this.pc.setLocalDescription(ans);
        await this._ctl({ t: "sig", d: { kind: "answer", sdp: this.pc.localDescription.sdp } });
      } else if (d.kind === "answer") {
        if (this.pc && this.pc.signalingState !== "stable") await this.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
      } else if (d.kind === "ice") {
        if (this.pc) { try { await this.pc.addIceCandidate(d.c); } catch (e) {} }
      }
    } catch (e) { this.relayAt = Date.now(); }
  }

  _bindDc() {
    const dc = this.dc;
    dc.onopen = () => this.notify();
    dc.onclose = () => { this.relayAt = Date.now(); };
    dc.onmessage = (ev) => { if (typeof ev.data === "string") this._onDcData(ev.data); };
  }

  _onDcData(data) {
    const p1 = data.indexOf(US);
    if (p1 < 0) return;
    const id = data.slice(0, p1);
    const rest = data.slice(p1 + 1);
    const p2 = rest.indexOf(US);
    if (p2 < 0) return;
    const idx = parseInt(rest.slice(0, p2), 10);
    const rest2 = rest.slice(p2 + 1);
    const p3 = rest2.indexOf(US);
    if (p3 < 0) return;
    const total = parseInt(rest2.slice(0, p3), 10);
    const piece = rest2.slice(p3 + 1);
    let e = this._dcChunks.get(id);
    if (!e) { e = { total, parts: new Array(total), got: 0 }; this._dcChunks.set(id, e); }
    if (e.parts[idx] === undefined) { e.parts[idx] = piece; e.got++; }
    if (e.got < e.total) return;
    this._dcChunks.delete(id);
    try { this._onBulk(JSON.parse(e.parts.join(""))); } catch (err) { console.warn("bulk frame bad", err); }
  }

  _onBulk(obj) {
    if (!obj || typeof obj !== "object") return;
    // On-demand chunk audio is session-independent (it can flow while no sync
    // session is running), so it's routed before the session-id guard.
    if (obj.t === "chrs") { this.engine._onChunkResponse(this.id, obj); return; }
    if (obj.sid !== this.sid) return;
    if (obj.t === "book") this._onBook(obj);
  }

  // A peer asked for some cached chunks. Answer with the ones we actually hold
  // (one bulk frame, or over the relay a single upload); a pure miss is a tiny
  // control-only "no", so it never costs an upload.
  async _onChunkReq(obj) {
    const id = obj && typeof obj.id === "string" ? obj.id : null;
    if (!id) return;
    const keys = Array.isArray(obj.keys) ? obj.keys : [];
    const items = [];
    if (chunkStore) {
      for (const k of keys) {
        if (items.length >= CHUNK_BATCH_MAX) break;
        if (typeof k !== "string" || k.length > CHUNK_KEY_MAX || k.indexOf("v2:mp3:") !== 0) continue;
        let blob = null;
        try { blob = await chunkStore.get(k); } catch (e) {}
        if (!blob) continue;
        try { items.push({ k, b: b64url(new Uint8Array(await blob.arrayBuffer())) }); } catch (e) {}
      }
    }
    if (!items.length) { this._ctl({ t: "chno", id }).catch(() => {}); return; }
    this.sendBulk({ t: "chrs", id, items });
  }

  async _bulkReady() {
    if (this.dc && this.dc.readyState === "open") return "dc";
    if (Date.now() >= this.relayAt) return "relay";
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        if (this.closed) { clearInterval(iv); resolve("relay"); }
        else if (this.dc && this.dc.readyState === "open") { clearInterval(iv); resolve("dc"); }
        else if (Date.now() >= this.relayAt) { clearInterval(iv); resolve("relay"); }
      }, 150);
    });
  }

  sendBulk(obj) {
    const run = async () => {
      const json = JSON.stringify(obj);
      const mode = await this._bulkReady();
      if (mode === "dc") await this._sendDc(json);
      else await this._sendRelay(json);
    };
    this._bulkQ = this._bulkQ.then(run).catch((e) => { console.warn("bulk send failed", e); this.stats.error = "transfer"; });
    return this._bulkQ;
  }

  async _sendDc(json) {
    const id = randId();
    const pieces = splitString(json, DC_CHUNK);
    for (let i = 0; i < pieces.length; i++) {
      while (this.dc && this.dc.bufferedAmount > 512 * 1024) await sleep(25);
      if (!this.dc || this.dc.readyState !== "open") throw new Error("channel_closed");
      this.dc.send(id + US + i + US + pieces.length + US + pieces[i]);
    }
  }

  async _sendRelay(json) {
    const b64 = b64url(await packBytes(this.engine.keys.relay, json));
    const res = await root.uploadPlugin(new Blob([b64], { type: "text/plain" }), { expires: Date.now() + 60 * 60 * 1000 });
    if (res.error) throw new Error(res.error);
    const id = randId();
    if (res.deletionUrl) this.relayUploads.set(id, res.deletionUrl);
    await this._ctl({ t: "relay", id, u: res.url });
  }

  async _onRelay(obj) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const r = await fetch(obj.u);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const text = (await r.text()).trim();
        const json = await unpackBytes(this.engine.keys.relay, unb64url(text));
        this._onBulk(JSON.parse(json));
        ok = true;
      } catch (e) { if (attempt === 1) { console.warn("relay download failed", e); this.stats.error = "transfer"; } }
    }
    // Ack either way so the sender can delete the temporary upload immediately.
    try { await this._ctl({ t: "relay_ack", id: obj.id }); } catch (e) {}
  }

  async _onRelayAck(obj) {
    const del = this.relayUploads.get(obj.id);
    if (!del) return;
    this.relayUploads.delete(obj.id);
    try { await fetch(del); } catch (e) {}
  }

  close() {
    this.closed = true;
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    try { if (this.pc) this.pc.close(); } catch (e) {}
    for (const del of this.relayUploads.values()) { try { fetch(del); } catch (e) {} }
    this.relayUploads.clear();
  }

  notify() { this.engine._notify(); }
}

// --- the engine -------------------------------------------------------------
export function createEngine(opts = {}) {
  const io = opts.io || defaultIO;
  const engine = {
    io,
    deviceId: opts.deviceId || null,
    name: opts.name || null,
    secretBytes: null,
    roomId: null,
    keys: null,
    coord: null,
    peers: new Map(),
    active: false,
    state: "idle",       // idle | connecting | waiting | syncing | done | error
    error: null,
    lastSyncAt: 0,
    _identityPromise: null,
    _listeners: new Set(),
    _sessionBusy: false,
  };

  engine.onUpdate = (cb) => { engine._listeners.add(cb); return () => engine._listeners.delete(cb); };
  engine._notify = () => { for (const cb of engine._listeners) { try { cb(); } catch (e) {} } };
  engine.flush = () => syncmeta.saveNow();

  engine.init = async () => {
    if (engine._identityPromise) return engine._identityPromise;
    engine._identityPromise = (async () => {
      await syncmeta.load();
      if (opts.identity) {
        engine.secretBytes = opts.identity.secretBytes || null;
        engine.name = opts.identity.name || deviceName();
        engine.deviceId = opts.identity.deviceId || syncmeta.getDeviceId();
        return;
      }
      const stored = await loadStoredIdentity();
      engine.name = (stored && stored.name) || engine.name || deviceName();
      engine.deviceId = engine.deviceId || syncmeta.getDeviceId();
      engine.secretBytes = stored ? stored.secretBytes : null;
      if (!stored) await saveStoredIdentity(null, engine.name);
    })();
    return engine._identityPromise;
  };

  async function ensureKeys() {
    if (engine.keys) return engine.keys;
    if (!engine.secretBytes) throw new Error("not_linked");
    engine.roomId = await sha256Hex(engine.secretBytes);
    engine.keys = {
      ctl: await deriveKey(engine.secretBytes, "ctl"),
      relay: await deriveKey(engine.secretBytes, "relay"),
    };
    return engine.keys;
  }

  engine.fingerprint = () => {
    if (!engine.roomId) return "";
    const hex = engine.roomId.toUpperCase().replace(/(.{4})/g, "$1 ").trim();
    return hex.slice(0, 19);   // e.g. "3F9A 12C4 88BE 0D11"
  };

  engine.linkUrl = () => {
    if (!engine.secretBytes) return "";
    const name = (typeof window !== "undefined" && window.generatorName) || "";
    return "https://perchance.org/" + name + "?sync=" + b64url(engine.secretBytes);
  };

  engine.inviteSecret = () => (engine.secretBytes ? b64url(engine.secretBytes) : "");

  engine.createInvite = async () => {
    await engine.init();
    if (!engine.secretBytes) {
      engine.secretBytes = randomSecret();
      engine.keys = null;
      engine.roomId = null;
      await saveStoredIdentity(engine.secretBytes, engine.name);
    }
    await ensureKeys();
    engine._notify();
    return engine.linkUrl();
  };

  engine.acceptInvite = async (secretStr) => {
    await engine.init();
    const bytes = unb64url(String(secretStr || ""));
    if (!bytes || bytes.length !== SECRET_BYTES) throw new Error("bad_secret");
    engine.secretBytes = bytes;
    engine.keys = null;
    engine.roomId = null;
    await saveStoredIdentity(bytes, engine.name);
    await ensureKeys();
    engine._notify();
    return true;
  };

  engine.unlink = async () => {
    engine.secretBytes = null;
    engine.keys = null;
    engine.roomId = null;
    engine._presence = false;
    engine.active = false;
    engine._reasons.clear();
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = 0; }
    if (engine.coord) { engine.coord.close(); engine.coord = null; }
    for (const p of engine.peers.values()) p.close();
    engine.peers.clear();
    engine.state = "idle";
    await saveStoredIdentity(null, engine.name || deviceName());
    engine._notify();
  };

  engine.connect = async () => {
    await engine.init();
    if (!engine.secretBytes) throw new Error("not_linked");
    if (engine.coord && !engine.coord.closed) return engine.coord;
    // Single-flight: several callers (presence, the sync UI, chunk fetching) can
    // ask to connect at once; only one of them should create the socket.
    if (engine._connectPromise) return engine._connectPromise;
    engine._connectPromise = (async () => {
      engine.state = engine.peers.size ? "syncing" : "connecting";
      engine.error = null;
      engine._notify();
      await ensureKeys();
      const coord = new Coordinator({
        roomId: engine.roomId,
        deviceId: engine.deviceId,
        name: engine.name,
        keys: engine.keys,
        onFrame: (from, obj) => engine._onFrame(from, obj),
        onPeer: (id, name) => engine._addPeer(id, name),
        onPeerGone: (id) => engine._removePeer(id),
        onStatus: (s) => {
          if (s === "offline") { engine.state = "error"; engine.error = "offline"; engine._notify(); }
        },
      });
      engine.coord = coord;
      try {
        await coord.connect();
      } catch (e) {
        engine.coord = null;
        engine.state = "error";
        engine.error = (e && e.message) || "connect_failed";
        engine._notify();
        throw e;
      }
      engine.state = engine.peers.size ? "syncing" : "waiting";
      engine._notify();
      return coord;
    })();
    try { return await engine._connectPromise; } finally { engine._connectPromise = null; }
  };

  // --- connection lifetime --------------------------------------------------
  // The coordination socket is shared by three users of it: the sync UI while
  // its modal is open, on-demand chunk fetching while a book is playing, and
  // (optionally) a background "presence" so two open devices can find each
  // other. We keep it open while *any* of them wants it, and close it a few
  // seconds after the last one lets go — an idle room membership is cheap, but
  // an idle socket isn't free, so it doesn't linger forever.
  engine._reasons = new Set();
  let disconnectTimer = 0;
  const scheduleDisconnect = () => {
    if (disconnectTimer) return;
    disconnectTimer = setTimeout(() => {
      disconnectTimer = 0;
      if (engine._reasons.size || engine._sessionBusy) return;
      engine.state = "idle";
      if (engine.coord) { engine.coord.close(); engine.coord = null; }
      for (const p of engine.peers.values()) p.close();
      engine.peers.clear();
      engine._notify();
    }, DISCONNECT_GRACE);
  };
  engine._wantConnect = (reason) => {
    engine._reasons.add(reason);
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = 0; }
    engine.connect().catch((e) => {
      engine.state = "error";
      engine.error = (e && e.message) || "connect_failed";
      engine._notify();
    });
  };
  engine._releaseConnect = (reason) => {
    engine._reasons.delete(reason);
    if (engine._reasons.size || engine._sessionBusy) return;
    scheduleDisconnect();
  };

  // Background presence: stay discoverable while this tab is visible so a peer
  // can pull cached audio from us. Hidden tabs let go (battery), and revealing
  // the tab reconnects.
  engine.setPresence = (on) => {
    engine._presence = !!on;
    if (!engine._presenceBound && typeof document !== "undefined" && document.addEventListener) {
      engine._presenceBound = true;
      document.addEventListener("visibilitychange", () => syncPresence());
    }
    syncPresence();
  };
  function syncPresence() {
    const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
    if (engine._presence && visible && engine.secretBytes) engine._wantConnect("presence");
    else engine._releaseConnect("presence");
  }

  engine.setActive = (on) => {
    engine.active = !!on;
    if (on) engine._wantConnect("ui");
    else engine._releaseConnect("ui");
    engine._notify();
  };

  engine._addPeer = (id, name) => {
    if (!id || id === engine.deviceId) return;
    let p = engine.peers.get(id);
    if (p && !p.closed) {
      if (name) p.name = name;
      p.notify();
      return;
    }
    p = new Peer(engine, id, name);
    engine.peers.set(id, p);
    p.start();
    engine.state = "syncing";
    engine._notify();
  };

  engine._removePeer = (id) => {
    const p = engine.peers.get(id);
    if (p) {
      const wasActive = p.sid && !p.finished;
      p.close();
      engine.peers.delete(id);
      if (wasActive) engine._peerFinished(p);
    }
    engine._notify();
  };

  engine._onFrame = (from, obj) => {
    if (!from) return;
    let p = engine.peers.get(from);
    if (!p || p.closed) { engine._addPeer(from, ""); p = engine.peers.get(from); }
    if (p) p.handle(obj);
  };

  engine._peerFinished = (peer) => {
    engine.lastSyncAt = Date.now();
    const allDone = [...engine.peers.values()].every((p) => p.finished || p.closed);
    if (allDone && engine._sessionBusy) {
      engine._sessionBusy = false;
      engine.state = "done";
      engine._notify();
      if (typeof engine.onSynced === "function") {
        try { engine.onSynced(engine.summary()); } catch (e) { console.warn(e); }
      }
    } else {
      engine._notify();
    }
    if (!engine._reasons.size) scheduleDisconnect();
  };

  engine.summary = () => {
    let sent = 0, recv = 0, deletes = 0, error = null;
    for (const p of engine.peers.values()) {
      sent += p.stats.sent; recv += p.stats.recv; deletes += p.stats.deletes;
      if (p.stats.error) error = p.stats.error;
    }
    return {
      sent, recv, deletes, error,
      peers: [...engine.peers.values()].map((p) => ({ id: p.id, name: p.name, finished: p.finished, sent: p.stats.sent, recv: p.stats.recv })),
    };
  };

  // Run a session now. Sessions are led by the lexicographically-smaller device
  // id, so a non-leader asks the leader to start one.
  engine.syncNow = async () => {
    await engine.init();
    if (!engine.secretBytes) throw new Error("not_linked");
    await engine.connect();
    const deadline = Date.now() + 8000;
    while (!engine.peers.size && Date.now() < deadline) await sleep(200);
    const peers = [...engine.peers.values()];
    if (!peers.length) { engine.state = "waiting"; engine._notify(); return engine.summary(); }
    engine.state = "syncing";
    engine._notify();
    for (const p of peers) {
      if (p.finished || !p.sid || p.closed) {
        if (p._isLeader()) p.beginSession();
        else p._ctl({ t: "request" }).catch(() => {});
      }
    }
    return engine.summary();
  };

  // ---- on-demand chunk sharing --------------------------------------------
  // engine.js calls engine.fetchChunk(cacheKey) whenever a chunk is missing from
  // the local audio cache. We gather the keys briefly (so a burst of misses
  // becomes one request), ask every connected peer which ones it holds, and
  // hand back the first copy that arrives. A miss is cheap; only hits move bytes.
  const chunkPending = new Map();   // cacheKey -> Set<resolve>
  const chunkQueue = new Set();     // cacheKeys waiting to be requested
  const chunkReqOf = new Map();     // request id -> { batchId }
  const chunkBatches = new Map();   // batchId -> { keys:Set, remaining, hits, timer }
  let chunkFlushTimer = 0;
  let chunkWaitTimer = 0;
  let chunkWaitSince = 0;
  let chunkMissStreak = 0;
  let chunkBackoffUntil = 0;
  let chunkIdleTimer = 0;

  const touchChunkConnect = () => {
    engine._wantConnect("chunks");
    if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
    chunkIdleTimer = setTimeout(() => { chunkIdleTimer = 0; engine._releaseConnect("chunks"); }, CHUNK_IDLE_MS);
  };

  const resolveChunk = (key, blob) => {
    const set = chunkPending.get(key);
    if (!set) return;
    chunkPending.delete(key);
    for (const r of set) { try { r(blob); } catch (e) {} }
  };
  const missChunk = (key) => resolveChunk(key, null);

  const finishBatch = (batchId) => {
    const batch = chunkBatches.get(batchId);
    if (!batch) return;
    chunkBatches.delete(batchId);
    if (batch.timer) clearTimeout(batch.timer);
    for (const [rid, info] of chunkReqOf) if (info.batchId === batchId) chunkReqOf.delete(rid);
    for (const k of batch.keys) missChunk(k);
    if (batch.hits > 0) { chunkMissStreak = 0; chunkBackoffUntil = 0; return; }
    const misses = batch.keys.size;
    if (!misses) return;
    chunkMissStreak += misses;
    if (chunkMissStreak >= CHUNK_MISS_LIMIT) {
      chunkBackoffUntil = Date.now() + CHUNK_BACKOFF_MS;
      chunkMissStreak = 0;
    }
  };

  const settleReq = (id, blobByKey) => {
    const info = chunkReqOf.get(id);
    if (!info) return;
    chunkReqOf.delete(id);
    const batch = chunkBatches.get(info.batchId);
    if (!batch) return;
    batch.remaining -= 1;
    if (blobByKey) {
      for (const [k, blob] of blobByKey) {
        if (!batch.keys.has(k)) continue;
        batch.keys.delete(k);
        batch.hits += 1;
        resolveChunk(k, blob);
      }
    }
    if (batch.remaining <= 0) finishBatch(info.batchId);
  };

  function failQueued() {
    const keys = [...chunkQueue];
    chunkQueue.clear();
    for (const k of keys) missChunk(k);
    if (keys.length) {
      chunkMissStreak += keys.length;
      if (chunkMissStreak >= CHUNK_MISS_LIMIT) { chunkBackoffUntil = Date.now() + CHUNK_BACKOFF_MS; chunkMissStreak = 0; }
    }
  }

  function flushChunks() {
    if (!chunkQueue.size) return;
    if (!engine.secretBytes || Date.now() < chunkBackoffUntil) { failQueued(); return; }
    const peers = [...engine.peers.values()].filter((p) => p && !p.closed && p.started);
    if (!peers.length) {
      if (!chunkWaitSince) chunkWaitSince = Date.now();
      if (Date.now() - chunkWaitSince < CHUNK_PEER_WAIT) {
        engine._wantConnect("chunks");
        if (chunkWaitTimer) clearTimeout(chunkWaitTimer);
        chunkWaitTimer = setTimeout(() => { chunkWaitTimer = 0; flushChunks(); }, 250);
        return;
      }
      chunkWaitSince = 0;
      failQueued();
      return;
    }
    chunkWaitSince = 0;
    const keys = [];
    for (const k of chunkQueue) { keys.push(k); if (keys.length >= CHUNK_BATCH_MAX) break; }
    if (!keys.length) return;
    for (const k of keys) chunkQueue.delete(k);
    const batchId = randId();
    const batch = { keys: new Set(keys), remaining: peers.length, hits: 0, timer: 0 };
    chunkBatches.set(batchId, batch);
    // A direct link answers in well under a second; the upload relay has to boot
    // its upload/download round trip, so it gets a lot longer.
    const direct = peers.some((p) => p.dc && p.dc.readyState === "open");
    batch.timer = setTimeout(() => finishBatch(batchId), direct ? CHUNK_REQ_TIMEOUT : CHUNK_RELAY_TIMEOUT);
    for (const p of peers) {
      const id = randId();
      chunkReqOf.set(id, { batchId });
      p._ctl({ t: "chreq", id, keys }).catch(() => settleReq(id, null));
    }
    if (chunkQueue.size) scheduleChunkFlush(CHUNK_BATCH_DELAY);
  }

  function scheduleChunkFlush(delay) {
    if (chunkFlushTimer) return;
    chunkFlushTimer = setTimeout(() => { chunkFlushTimer = 0; flushChunks(); }, delay);
  }

  engine.fetchChunk = (key) => {
    if (!key || typeof key !== "string" || !engine.secretBytes) return Promise.resolve(null);
    if (Date.now() < chunkBackoffUntil) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      let set = chunkPending.get(key);
      if (!set) { set = new Set(); chunkPending.set(key, set); }
      set.add(fin);
      // Absolute upper bound, independent of the batch machinery.
      setTimeout(() => {
        const s = chunkPending.get(key);
        if (s) { s.delete(fin); if (!s.size) chunkPending.delete(key); }
        fin(null);
      }, CHUNK_ABS_TIMEOUT);
      chunkQueue.add(key);
      touchChunkConnect();
      scheduleChunkFlush(0);
    });
  };

  engine._onChunkResponse = (peerId, obj) => {
    if (!obj || typeof obj.id !== "string") return;
    if (obj.t === "chno") { settleReq(obj.id, null); return; }
    if (obj.t === "chrs" && Array.isArray(obj.items)) {
      const map = new Map();
      for (const it of obj.items) {
        if (!it || typeof it.k !== "string" || typeof it.b !== "string") continue;
        try { map.set(it.k, new Blob([unb64url(it.b)], { type: "audio/mpeg" })); } catch (e) {}
      }
      settleReq(obj.id, map);
    }
  };

  engine.getStatus = () => ({
    linked: !!engine.secretBytes,
    requested: !!engine.active,
    fingerprint: engine.fingerprint(),
    deviceId: engine.deviceId,
    name: engine.name,
    state: engine.state,
    error: engine.error,
    lastSyncAt: engine.lastSyncAt,
    peers: [...engine.peers.values()].map((p) => ({
      id: p.id, name: p.name, finished: p.finished, closed: p.closed, sid: p.sid,
      transport: p.dc && p.dc.readyState === "open" ? "direct" : (Date.now() >= p.relayAt ? "relay" : "connecting"),
      sent: p.stats.sent, recv: p.stats.recv,
    })),
  });

  return engine;
}

// The app-wide singleton.
export const engine = createEngine();

// Test seam: lets a test run two isolated engines side by side.
export { defaultIO };
