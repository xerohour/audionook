// ===========================================================================
// player.js — streaming playback of a chunked audiobook.
//
// Audio for chunk i is produced by the engine on demand and prioritised around
// the playhead, so pressing play after the FIRST chunk is ready starts playback
// immediately while the rest of the book synthesises in the background.
//
// Two <audio> elements are ping-ponged so the next chunk is preloaded and the
// gap between chunks stays tiny. The invariant that keeps this correct under
// every user action (seek, skip, voice change, rate change, replay) is:
//
//   * exactly one element "owns" the current chunk (`this.active`), and
//   * it is the ONLY element that is allowed to be playing.
//
// Every transition routes through `_startAt()`, which pauses the other element
// before starting the new one, so two voices can never overlap. Element events
// are ignored unless they come from the owning element, and a monotonically
// increasing token discards stale async play() callbacks.
// ===========================================================================

import { WORDS_PER_MINUTE } from "./config.js";
import { coverDataUrl } from "./util.js";
import { coverUrlFor } from "./covers.js";

export class Player {
  constructor({ engine, onState, onListen, onBookEnd }) {
    this.engine = engine;
    this.onState = onState || (() => {});
    this.onListen = onListen || (() => {});
    this.onBookEnd = onBookEnd || (() => {});
    this.book = null;
    this.chunks = [];
    this.blobs = new Map();   // index -> {blob, url}
    this.durations = new Map(); // index -> duration (seconds), when known
    this.currentIndex = 0;
    this.offset = 0;
    this.isPlaying = false;
    this.buffering = false;
    this.rate = 1;
    this.voice = null;
    this.active = 0;
    this._token = 0;
    this.el = [new Audio(), new Audio()];
    for (const a of this.el) { a.preload = "auto"; a._idx = -1; a._seekTo = 0; a._pending = false; }
    this._attachHandlers();
    this._emitScheduled = false;
    this._listenTicker = null;
    this._watchdog = null;
    this._unstickTries = 0;
    this._lastTick = performance.now();
  }

  _attachHandlers() {
    this.el.forEach((el) => {
      el.addEventListener("ended", () => {
        if (el !== this.activeEl) return;   // ignore stragglers from the other slot
        this._advance();
      });
      el.addEventListener("timeupdate", () => {
        if (el !== this.activeEl) return;
        this.offset = el.currentTime || 0;
        this._scheduleEmit();
      });
      el.addEventListener("loadedmetadata", () => {
        if (el._idx >= 0 && el.duration && isFinite(el.duration)) this.durations.set(el._idx, el.duration);
        if (el._seekTo > 0) {
          try { el.currentTime = Math.min(el._seekTo, Math.max(0, (el.duration || 0) - 0.05)); } catch (e) {}
          el._seekTo = 0;
        }
        this._scheduleEmit();
      });
      el.addEventListener("playing", () => {
        if (el !== this.activeEl) return;
        el._pending = false;
        this.buffering = false;
        this._unstickTries = 0;
        this._scheduleEmit();
      });
      el.addEventListener("waiting", () => {
        if (el !== this.activeEl) return;
        this.buffering = true;
        this._scheduleEmit();
      });
      el.addEventListener("play", () => { el._pending = false; });
      el.addEventListener("error", () => {
        if (el !== this.activeEl) return;
        el._pending = false;
        this.buffering = false;
        this._scheduleEmit();
      });
    });
  }

  get activeEl() { return this.el[this.active]; }
  get otherEl() { return this.el[1 - this.active]; }
  get total() { return this.chunks.length; }

  open(book, chunks, { position = null, voice = null } = {}) {
    this.close(false);
    this.book = book;
    this.chunks = chunks;
    this.voice = voice || book.voice;
    this.currentIndex = 0;
    this.offset = 0;
    this.isPlaying = false;
    this.buffering = false;
    this.active = 0;
    if (position && position.index >= 0 && position.index < chunks.length) {
      this.currentIndex = position.index;
      this.offset = position.offset || 0;
    }
    this.engine.setBook(chunks, this.voice);
    this.engine.setFocus(this.currentIndex);
    this._startListenTicker();
    this._emit();
  }

  close(emit = true) {
    this._token++;
    for (const el of this.el) {
      el._pending = false;
      try { el.pause(); } catch (e) {}
      el.removeAttribute("src");
      try { el.load(); } catch (e) {}
      el._idx = -1;
      el._seekTo = 0;
    }
    for (const rec of this.blobs.values()) { try { URL.revokeObjectURL(rec.url); } catch (e) {} }
    this.blobs.clear();
    this.durations.clear();
    if (this._listenTicker) { clearInterval(this._listenTicker); this._listenTicker = null; }
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    this.book = null;
    this.chunks = [];
    this.isPlaying = false;
    this.buffering = false;
    if (emit) this._emit();
  }

  // --- chunk arrival ---------------------------------------------------------
  onEngineChunk({ index, blob }) {
    if (!this.book) return;
    if (index < 0 || index >= this.chunks.length) return;
    if (!this.blobs.has(index)) {
      this.blobs.set(index, { blob, url: URL.createObjectURL(blob) });
    }
    if (this.isPlaying) {
      const owned = this.activeEl._idx === index && !this.activeEl.paused;
      if (index === this.currentIndex && !owned) {
        this._startAt(index, this.offset);
      } else if (index === this.currentIndex + 1) {
        this._preload(index);
      }
    } else if (index === this.currentIndex) {
      this._preload(index);
    }
    this._scheduleEmit();
  }

  onEngineError({ index }) {
    this.failed = this.failed || new Set();
    this.failed.add(index);
    this._scheduleEmit();
  }

  // --- transport -------------------------------------------------------------
  play() {
    if (!this.book) return;
    this.isPlaying = true;
    this._unstickTries = 0;
    if (this.blobs.has(this.currentIndex)) {
      const el = this.activeEl;
      if (el._idx === this.currentIndex && !el.paused) {
        // already rolling — nothing to do
      } else {
        this._startAt(this.currentIndex, this.offset);
      }
    } else {
      this.buffering = true;
      this._pauseAll();
      this.engine.setFocus(this.currentIndex);
    }
    this._setMediaPlaybackState(true);
    this._emit();
  }

  pause() {
    this.isPlaying = false;
    this._pauseAll();
    this._setMediaPlaybackState(false);
    this._emit();
  }

  toggle() { this.isPlaying ? this.pause() : this.play(); }

  seekToIndex(i, offset = 0) {
    if (!this.book) return;
    this._unstickTries = 0;
    i = Math.max(0, Math.min(this.chunks.length - 1, i | 0));
    this.currentIndex = i;
    this.offset = Math.max(0, offset);
    this.engine.setFocus(i);
    if (this.isPlaying) {
      if (this.blobs.has(i)) this._startAt(i, this.offset);
      else { this.buffering = true; this._pauseAll(); }
    } else {
      this._preload(i);
    }
    this._emit();
  }

  skip(seconds) {
    if (!this.book) return;
    let i = this.currentIndex;
    let t = (this.offset || 0) + seconds;
    let guard = 0;
    if (t < 0) {
      // walk backwards across chunks until t is inside chunk i
      while (t < 0 && i > 0 && guard++ < 2000) { i--; t += this.chunkDuration(i); }
    } else {
      while (i < this.chunks.length - 1 && t > this.chunkDuration(i) && guard++ < 2000) {
        t -= this.chunkDuration(i); i++;
      }
    }
    // If we ran past the final chunk, clamp just inside its end rather than
    // silently jumping to the very end (which looks like playback "jumped").
    if (i >= this.chunks.length - 1) {
      const lastDur = this.chunkDuration(this.chunks.length - 1);
      t = Math.min(Math.max(0, t), Math.max(0, lastDur - 0.25));
    }
    this.seekToIndex(i, Math.max(0, t));
  }

  setRate(rate) {
    this.rate = Math.max(0.5, Math.min(3, rate));
    for (const el of this.el) { try { el.playbackRate = this.rate; el.preservesPitch = true; } catch (e) {} }
    this._emit();
  }

  setVoice(voice) {
    if (voice === this.voice) return;
    this.voice = voice;
    // Voice changed => every chunk must be regenerated. Keep the logical
    // playhead (index + offset) so playback resumes at the same spot.
    this._token++;
    this._pauseAll();
    for (const el of this.el) { el._idx = -1; el._seekTo = 0; }
    for (const rec of this.blobs.values()) { try { URL.revokeObjectURL(rec.url); } catch (e) {} }
    this.blobs.clear();
    this.durations.clear();
    this.engine.setBook(this.chunks, voice);
    this.engine.setFocus(this.currentIndex);
    this.buffering = this.isPlaying;
    this._emit();
  }

  // --- internals -------------------------------------------------------------
  _pauseAll() {
    for (const el of this.el) { el._pending = false; try { el.pause(); } catch (e) {} }
  }

  // The one-and-only place playback begins. Always pauses the other element
  // first, so the two slots can never sound at once.
  _startAt(i, offset) {
    if (!this.book) return;
    const rec = this.blobs.get(i);
    if (!rec) {
      // The chunk isn't synthesised yet. Critically, move the logical playhead
      // to it *now*: when the chunk later arrives, onEngineChunk only resumes
      // playback for `index === currentIndex`. Leaving currentIndex pointing at
      // the previous (finished) chunk made the arrival look like a preload of
      // the *next* chunk, so playback stayed "buffering" until pause/unpause.
      this._pauseAll();
      this.currentIndex = i;
      this.offset = Math.max(0, offset || 0);
      this.buffering = true;
      this.engine.setFocus(i);
      this._emit();
      return;
    }
    const target = this.otherEl;
    // Stop everything before pointing the next element at the new chunk. This
    // is the fix for "two voices at once" when seeking mid-playback.
    this._pauseAll();
    this.active = 1 - this.active;
    this.currentIndex = i;
    this.offset = Math.max(0, offset || 0);
    if (target._idx !== i) {
      target._idx = i;
      target._seekTo = 0;
      target.src = rec.url;
    }
    try { target.playbackRate = this.rate; target.preservesPitch = true; } catch (e) {}
    // Always pin the playhead to the requested offset. When the element was
    // preloaded with this same chunk it still holds an old currentTime, so
    // skipping/back-seeking to 0 would otherwise resume mid-chunk.
    if (target.readyState >= 1) { try { target.currentTime = this.offset; } catch (e) {} }
    else target._seekTo = this.offset;
    this.buffering = false;
    const token = ++this._token;
    target._pending = true;
    const p = target.play();
    if (p && p.catch) p.catch(() => { if (token === this._token) { target._pending = false; this.buffering = true; this._scheduleEmit(); } });
    this._preload(i + 1);
    this.engine.setFocus(Math.min(this.chunks.length - 1, i + 1));
    this._setMediaPlaybackState(true);
    this._emit();
  }

  _preload(j) {
    if (j < 0 || j >= this.chunks.length) return;
    const rec = this.blobs.get(j);
    if (!rec) return;
    const el = this.otherEl;
    if (el._idx === j) return;
    el._idx = j;
    el._seekTo = 0;
    el.src = rec.url;
    try { el.playbackRate = this.rate; } catch (e) {}
  }

  _advance() {
    const next = this.currentIndex + 1;
    if (next >= this.chunks.length) {
      this.isPlaying = false;
      this.offset = this.chunkDuration(this.currentIndex);
      this._pauseAll();
      this._setMediaPlaybackState(false);
      this.onBookEnd();
      this._emit();
      return;
    }
    this._startAt(next, 0);
  }

  chunkDuration(i) {
    if (this.durations.has(i)) return this.durations.get(i);
    const c = this.chunks[i];
    const words = c ? String(c.text || "").trim().split(/\s+/).filter(Boolean).length : 0;
    return Math.max(1.2, (words / WORDS_PER_MINUTE) * 60 + (c && c.isStartOfParagraph ? 0.3 : 0));
  }

  get readyCount() {
    // Delivered blobs plus chunks the background prefetch has already resolved
    // into the local cache (playable with neither a peer nor the CPU). The sum
    // is what the buffered bar shows, so a whole book syncing in from another
    // device visibly fills it.
    let n = this.blobs.size;
    const eng = this.engine;
    if (eng && eng.cachedCount) n += eng.cachedCount;
    return Math.min(n, this.chunks.length);
  }

  elapsed() {
    let t = 0;
    for (let i = 0; i < this.currentIndex; i++) t += this.chunkDuration(i);
    return t + (this.offset || 0);
  }

  totalDuration() {
    let t = 0;
    for (let i = 0; i < this.chunks.length; i++) t += this.chunkDuration(i);
    return t;
  }

  getState() {
    const total = this.totalDuration();
    const elapsed = Math.min(this.elapsed(), total);
    return {
      book: this.book,
      chunks: this.chunks,
      currentIndex: this.currentIndex,
      offset: this.offset,
      isPlaying: this.isPlaying,
      buffering: this.buffering,
      rate: this.rate,
      readyCount: this.readyCount,
      total: this.chunks.length,
      duration: total,
      elapsed,
      progress: total > 0 ? elapsed / total : 0,
      voice: this.voice,
    };
  }

  _scheduleEmit() {
    if (this._emitScheduled) return;
    this._emitScheduled = true;
    requestAnimationFrame(() => { this._emitScheduled = false; this._emit(); });
  }
  _emit() { this.onState(this.getState()); }

  _startListenTicker() {
    if (this._listenTicker) clearInterval(this._listenTicker);
    if (this._watchdog) clearInterval(this._watchdog);
    this._lastTick = performance.now();
    this._listenTicker = setInterval(() => {
      const now = performance.now();
      const dt = (now - this._lastTick) / 1000;
      this._lastTick = now;
      if (this.isPlaying && !this.buffering && dt > 0 && dt < 40) {
        this.onListen(Math.min(dt, 20));
      }
    }, 15000);
    // Safety net: if the active element is sitting paused on a chunk we already
    // have while we believe we're playing, restart it. Belt-and-braces for any
    // remaining stall path (e.g. a silently-rejected play()).
    this._watchdog = setInterval(() => this._unstick(), 1000);
  }

  _unstick() {
    if (!this.book || !this.isPlaying) return;
    if (!this.blobs.has(this.currentIndex)) return;
    const el = this.activeEl;
    if (el._idx !== this.currentIndex || el._pending || !el.paused || el.ended) return;
    if (this._unstickTries > 3) return;
    this._unstickTries++;
    this._startAt(this.currentIndex, this.offset);
  }

  _setMediaPlaybackState(playing) {
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch (e) {}
    }
  }

  setupMediaSession(getCoverUrl) {
    if (!("mediaSession" in navigator)) return;
    const b = this.book;
    if (!b) return;
    let artwork = [];
    const coverSrc = coverUrlFor(b);
    if (coverSrc) artwork = [{ src: coverSrc, sizes: "512x512", type: "image/jpeg" }];
    else {
      try { artwork = [{ src: coverDataUrl(b.title || b.id, 512, (b.title || "A")[0]), sizes: "512x512", type: "image/jpeg" }]; } catch (e) {}
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: b.title || "Audionook",
        artist: b.author || "Unknown author",
        album: "Audionook",
        artwork,
      });
      const h = navigator.mediaSession;
      h.setActionHandler("play", () => this.play());
      h.setActionHandler("pause", () => this.pause());
      h.setActionHandler("seekbackward", () => this.skip(-10));
      h.setActionHandler("seekforward", () => this.skip(30));
      h.setActionHandler("seekto", (d) => {
        const i = Math.round((d.seekTime / Math.max(1, this.totalDuration())) * this.chunks.length);
        this.seekToIndex(i, 0);
      });
    } catch (e) {}
  }
}
