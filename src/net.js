// ===========================================================================
// net.js — client for the authoritative server plugin (Explore backend).
//
// Wire format is a compact delimited text protocol (never JSON on the server
// side): fields are separated by U+001F and rows by U+001E. See the server
// script at the top of index.html for the matching encoder/decoder.
// ===========================================================================

import { FLAG, tagNamesFromBits } from "./config.js";

export const US = "\u001f"; // unit separator: between fields
export const RS = "\u001e"; // record separator: between rows

export class ServerNet {
  constructor() {
    this.socket = null;
    this.status = "idle"; // idle | connecting | online | offline | blocked
    this._statusListeners = new Set();
    this._newListeners = new Set();
    this._readyWaiters = [];
    this._connecting = null;
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
    this._closedOnce = false;
  }

  onStatus(cb) { this._statusListeners.add(cb); cb(this.status); return () => this._statusListeners.delete(cb); }
  onNew(cb) { this._newListeners.add(cb); return () => this._newListeners.delete(cb); }
  _emitStatus(s) { this.status = s; for (const cb of this._statusListeners) { try { cb(s); } catch (e) {} } }

  connect() {
    if (this._connecting) return this._connecting;
    this._connecting = this._doConnect().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _doConnect() {
    if (this.status === "blocked") return null;
    this._emitStatus("connecting");
    let socket;
    try {
      socket = root.createServerSocket();
      this.socket = socket;
      await socket.opened;
    } catch (e) {
      console.warn("server connect failed:", e);
      if (e && e.code === "NO_PERCHANCE_SERVER") {
        // Self-hosted build: no Perchance backend exists at all. Reuse the
        // permanent "blocked" path (same as websocket close code 4403 for a
        // generator embedded off perchance.org) — never retry.
        this._emitStatus("blocked");
        return null;
      }
      this._emitStatus("offline");
      this._scheduleReconnect();
      return null;
    }
    socket.addEventListener("message", (ev) => this._onMessage(ev));
    socket.addEventListener("close", (ev) => this._onClose(ev));
    this._reconnectDelay = 1000;
    this._emitStatus("online");
    // The server auto-subscribes every connection to the "new" topic.
    const waiters = this._readyWaiters.splice(0);
    for (const w of waiters) w();
    return socket;
  }

  _onMessage(ev) {
    const data = ev.data;
    if (typeof data !== "string") return;
    for (const line of data.split(RS)) {
      if (!line) continue;
      const book = parseRow(line);
      if (book) for (const cb of this._newListeners) { try { cb(book); } catch (e) {} }
    }
  }

  _onClose(ev) {
    this.socket = null;
    const code = ev && ev.code;
    if (code === 4403) {
      // Platform-level restriction (generator embedded off perchance.org) —
      // permanent, never retry (see server-plugin docs).
      this._emitStatus("blocked");
      return;
    }
    this._emitStatus("offline");
    // Reject any pending ready-waiters so callers don't hang forever.
    const waiters = this._readyWaiters.splice(0);
    for (const w of waiters) w();
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this.status === "blocked") return;
    const delay = Math.min(30000, this._reconnectDelay) * (0.7 + Math.random() * 0.6);
    this._reconnectDelay = Math.min(30000, this._reconnectDelay * 1.8);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _waitReady(timeoutMs = 8000) {
    if (this.status === "online" && this.socket) return Promise.resolve(true);
    this.connect();
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.status === "online"), timeoutMs);
      this._readyWaiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  async _rpc(method, data) {
    const ok = await this._waitReady();
    if (!ok || !this.socket || this.status !== "online") throw new Error("offline");
    return this.socket.rpc[method](data);
  }

  async list(opts = {}) {
    const tagHex = /^[0-9a-f]{64}$/.test(opts.tagBits || "") ? opts.tagBits : "";
    const payload = [
      opts.sort || "top",
      String(opts.offset | 0),
      String(opts.limit || 48),
      tagHex,
      opts.query || "",
    ].join(US);
    const res = await this._rpc("list", payload);
    return parseListing(res);
  }

  async submit(record) {
    const tagHex = /^[0-9a-f]{64}$/.test(record.tagBits || "") ? record.tagBits : "0".repeat(64);
    const payload = [
      record.hashA >>> 0, record.hashB >>> 0,
      record.title, record.author,
      tagHex, record.wordCount | 0, record.flags >>> 0,
      record.bundleId,
    ].join(US);
    const res = await this._rpc("submit", payload);
    // ok<US>seq<US>(0|1 deduped)  |  err<US>code
    const p = String(res).split(US);
    if (p[0] === "ok") return { ok: true, seq: +p[1], deduped: p[2] === "1" };
    return { ok: false, error: p[1] || "error" };
  }

  async report(seq, seconds) {
    const res = await this._rpc("report", `${seq}${US}${Math.round(seconds)}`);
    return +res || 0;
  }

  async play(seq) {
    try { return (await this._rpc("play", String(seq))) === "1"; } catch (e) { return false; }
  }

  async stats() {
    const res = await this._rpc("stats", "");
    const p = String(res).split(US);
    return {
      books: +p[0] || 0, listenSec: +p[1] || 0, submissions: +p[2] || 0,
      evictions: +p[3] || 0, capacity: +p[4] || 0,
    };
  }

  async get(seq) {
    try {
      const res = await this._rpc("get", String(seq));
      return res ? parseRow(res) : null;
    } catch (e) { return null; }
  }
}

export function parseRow(line) {
  const p = line.split(US);
  if (p.length < 10) return null;
  const [seq, listen, plays, words, created, flags, tags, title, author, bundleId] = p;
  const f = +flags || 0;
  const tagHex = /^[0-9a-f]{64}$/i.test(tags || "") ? String(tags).toLowerCase() : "0".repeat(64);
  return {
    id: "s:" + seq,
    seq: +seq,
    listenSec: +listen || 0,
    plays: +plays || 0,
    wordCount: +words || 0,
    createdAt: (+created || 0) * 1000,
    flags: f,
    customCover: !!(f & FLAG.CUSTOM_COVER),
    tags: tagNamesFromBits(tagHex),
    tagBits: tagHex,
    title: title || "Untitled",
    author: author || "",
    // Not in the row: the bulky fields are fetched lazily from the upload bundle
    // (`share.fetchBundle(row.bundleId)` then `share.applyBundle`). The NSFW
    // determination is made at view time from the host's file tags, never from
    // the uploader's claims.
    bundleId: bundleId || "",
    blurb: "",
    textUrl: "",
    coverUrl: "",
    voice: null,
    nsfw: false,
    origin: "explore",
  };
}

export function parseListing(res) {
  const parts = String(res || "").split(RS);
  const header = parts.shift().split(US);
  const [total, listenSec, books, offset, returned] = header;
  const items = parts.filter(Boolean).map(parseRow).filter(Boolean);
  return {
    total: +total || 0,
    listenSec: +listenSec || 0,
    books: +books || 0,
    offset: +offset || 0,
    returned: +returned || 0,
    items,
  };
}
