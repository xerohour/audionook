// ===========================================================================
// app.js — the application hub: boot, routing, playback UI, publishing.
//
// Architecture in one line: the TTS engine (engine.js) turns text chunks into
// MP3 blobs on the user's device; the Player (player.js) streams those blobs;
// the ServerNet (net.js) talks to the authoritative Explore backend; share.js
// handles uploads + AI catalogue metadata; views.js draws the three views.
//
// Nothing here uploads audio. A published audiobook is (text URL + voice), and
// every listener synthesises it locally, which is why the shared server state
// can stay tiny and why evicted books still work from their direct link.
// ===========================================================================

import * as store from "./store.js";
import * as share from "./share.js";
import * as backup from "./backup.js";
import * as fssync from "./fssync.js";
import * as devicesync from "./devicesync.js";
import * as covers from "./covers.js";
import { openCropper } from "./crop.js";
import { TTSEngine, splitTextIntoChunks, setChunkFetcher, getCachedChunk, putCachedChunk } from "./engine.js";
import { Player } from "./player.js";
import { ServerNet } from "./net.js";
import { joinMp3Blobs } from "./audio.js";
import { renderExplore, renderLibrary, renderCreate, refreshExploreCard } from "./views.js";
import { Reformatter } from "./reformat.js";
import { bookCard, coverNode, spinnerNode, paintProceduralCover, emptyState, chip } from "./ui.js";
import {
  $, $$, el, icon, brandMarkSvg, brandFaviconDataUrl, toast, openModal, closeModal, isModalOpen, uid, wordCount,
  debounce, copyText, sleep, formatDuration, formatLongDuration, formatCompact,
  truncate, escapeHtml, coverStyle, openContextMenu, closeContextMenu, timeAgo,
} from "./util.js";
import * as storage from "./storage.js";
import {
  ALL_VOICES, FEATURED_VOICE_IDS, LIGHT_VOICE_IDS, voiceLabel, SAMPLE_TEXT, TAGS,
  tagBitsFromNames, MAX_TAGS_PER_BOOK, MAX_BLURB, MAX_TITLE, MAX_AUTHOR,
  PAGE_SIZE, WORDS_PER_MINUTE, SLEEP_OPTIONS, COVER_ASPECT, PREFETCH_WINDOW,
} from "./config.js";
import { engineForVoice, isLightVoice, MIN_RTF } from "./paradee.js";

const app = {
  route: "create",
  settings: null,
  engine: null, player: null, net: null,
  enginePromises: null,
  currentBook: null,
  library: [], positions: {},
  positionsLoaded: false,
  collections: [],
  bookmarks: [],
  bmQueue: null,
  bookQueue: null,
  libraryView: { collectionId: null, showArchived: false, bookmarks: false, bookmarkTag: null, drag: null, readFilter: "all", tagFilter: [], filterOpen: false },
  titling: new Set(),
  explore: {
    sort: "top", tagBits: "", query: "", offset: 0, items: [], total: 0,
    loading: false, error: false, verifying: 0, stats: null, tagOpen: false, tagQuery: "",
  },
  searchQuery: "",
  create: { text: "", voice: null, refs: {} },
  reformat: { run: null, stage: null },
  engineStatus: { started: false, ready: false, phase: null, progress: 0, device: null, gpuFailed: false, hasWebGpu: false, failed: false },
  playerOpen: false,
  failedChunks: new Set(),
  listenPending: 0,
  userScrolledAt: 0,
  previewCache: new Map(),
  scrubDragging: false,
  scrubFrac: 0,
  sleeping: false,
};
window.__app = app;

// ===========================================================================
// Boot
// ===========================================================================
async function boot() {
  store.ensurePersistentStorage();
  app.settings = await store.getSettings();

  // Restore an unsaved Create-pane draft (text they were still editing) so a
  // refresh doesn't lose it — cleared once the audiobook is actually created.
  const draft = await store.getCreateDraft();
  if (draft) {
    if (typeof draft.text === "string") app.create.text = draft.text;
    if (draft.voice) app.create.voice = draft.voice;
    if (draft.reformatPreset) app.create.reformatPreset = draft.reformatPreset;
    if (typeof draft.reformatCustom === "string") app.create.reformatCustom = draft.reformatCustom;
    // PORT: reformat needs the Perchance backend — never restore it on, so a
    // draft carried over from the hosted version can't show the AI panel.
    app.create.reformatOn = false;
  }

  applyTheme();
  buildChrome();
  buildTopBar();
  buildNav();

  setupEngine();
  app.net = new ServerNet();
  app.net.onNew(onNewBook);
  app.net.connect();

  setupPlayer();
  setupPlayerScreen();
  setupKeyboard();
  setupCreateDrop();
  setupDeepLink();
  setupDeviceSync();

  await loadLibrary();
  await loadCollections();
  await loadBookmarks();
  showRoute(app.route, { initial: true });
  loadExplore({ reset: true });

  // First frame is rendered — lift the boot splash (see index.html).
  if (window.__boot) window.__boot.ready();

  // The voice model is loaded lazily (first play / preview / create), never
  // speculatively on load, and released again once idle (see tickEngineIdle).
  setInterval(() => tickEngineIdle(), 30000);

  window.addEventListener("online", () => { if (app.net.status === "offline") app.net.connect(); });
  window.addEventListener("beforeunload", () => { persistPosition(); flushCreateDraft(); devicesync.engine.flush(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { persistPosition(); flushCreateDraft(); devicesync.engine.flush(); } });
  setInterval(() => persistPosition(), 30000);
}

// Brand mark + favicon live here (the platform owns <head>, so we add the icon
// link from JS). The mark is drawn by util.js so both stay in sync.
function buildChrome() {
  const mark = $(".brand-mark");
  if (mark) mark.innerHTML = brandMarkSvg({ size: 26 });
  if (!document.querySelector('link[rel="icon"]')) {
    const link = el("link", { rel: "icon", type: "image/svg+xml", href: brandFaviconDataUrl() });
    document.head.appendChild(link);
  }
}

// ===========================================================================
// Theme
// ===========================================================================
let mediaQuery = null;
function resolveTheme() {
  const t = app.settings.theme;
  if (t === "light" || t === "dark" || t === "black") return t;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme() {
  const theme = resolveTheme();
  document.documentElement.dataset.theme = theme;
  const btn = $("#themeBtn");
  if (btn) btn.innerHTML = icon(theme === "light" ? "sun" : "moon", { size: 20 });
  const npBtn = $("#npThemeBtn");
  if (npBtn) npBtn.innerHTML = icon(theme === "light" ? "sun" : "moon", { size: 19 });
  if (!mediaQuery && window.matchMedia) {
    mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => { if (app.settings.theme === "auto") applyTheme(); };
    mediaQuery.addEventListener ? mediaQuery.addEventListener("change", onChange) : mediaQuery.addListener(onChange);
  }
}
function toggleTheme() {
  app.settings.theme = resolveTheme() === "light" ? "dark" : "light";
  store.setSetting("theme", app.settings.theme);
  applyTheme();
}

// ===========================================================================
// Chrome (top bar / nav)
// ===========================================================================
function buildTopBar() {
  const actions = $(".topbar-actions");
  const settingsBtn = el("button", { class: "icon-btn", id: "settingsBtn", title: "Settings", html: icon("sliders", { size: 19 }) });
  settingsBtn.addEventListener("click", openSettings);
  actions.appendChild(settingsBtn);

  $("#themeBtn").addEventListener("click", toggleTheme);
  setupInstallButton();

  const search = $("#searchInput");
  const run = debounce(() => setSearch(search.value.trim()), 320);
  search.addEventListener("input", run);
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); setSearch(search.value.trim()); } });
  app.updateSearchPlaceholder = () => {
    const lib = app.route === "library";
    search.placeholder = window.innerWidth < 560 ? "Search" : (lib ? "Search your audiobooks, authors, tags…" : "Search audiobooks, authors, tags…");
  };
  app.updateSearchPlaceholder();
  window.addEventListener("resize", app.updateSearchPlaceholder);
}

// Install button: shown only when the browser fires `beforeinstallprompt`
// (i.e. PWA install is supported here) and the app isn't already running
// installed. Sits left of the theme button per header order. Logic mirrors
// https://perchance.org/installable-app-demo.
function isRunningAsApp() {
  try {
    if (window.matchMedia) {
      if (window.matchMedia("(display-mode: standalone)").matches) return true;
      if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
    }
  } catch (e) {}
  try { if (window.navigator && window.navigator.standalone === true) return true; } catch (e) {}
  return false;
}

function setupInstallButton() {
  const actions = $(".topbar-actions");
  const themeBtn = $("#themeBtn");
  if (!actions || !themeBtn) return;
  const btn = el("button", { class: "chip-btn install-btn", id: "installBtn", title: "Install app", hidden: true });
  btn.appendChild(el("span", { class: "install-ic", html: icon("download", { size: 16 }) }));
  btn.appendChild(el("span", { class: "install-label", text: "Install" }));
  // Left of the dark-mode (theme) button.
  actions.insertBefore(btn, themeBtn);
  let deferred = null;
  const update = () => { btn.hidden = !(deferred && !isRunningAsApp()); };
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    if (isRunningAsApp()) { deferred = null; update(); return; }
    deferred = e;
    update();
  });
  window.addEventListener("appinstalled", () => { deferred = null; btn.hidden = true; });
  try {
    const mq = window.matchMedia ? window.matchMedia("(display-mode: standalone)") : null;
    if (mq) {
      const onChange = () => update();
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  } catch (e) {}
  btn.addEventListener("click", async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      let outcome = null;
      try { outcome = (await deferred.userChoice || {}).outcome || null; } catch (e) {}
      // `appinstalled` hides the button on accept; a dismiss keeps it for retry.
      if (outcome === "accepted") btn.hidden = true;
    } catch (e) {}
  });
  update();
}

function buildNav() {
  for (const item of $$("[data-route]")) {
    item.addEventListener("click", () => navigate(item.dataset.route));
  }
}

// ===========================================================================
// Routing
// ===========================================================================
function showRoute(route, { initial = false } = {}) {
  // PORT: the Explore listing needs the Perchance backend; its nav is hidden,
  // so any stray navigation to it lands on the Library instead.
  if (route === "explore") route = "library";
  if (!["explore", "library", "create"].includes(route)) route = "create";
  app.route = route;
  for (const v of $$(".view")) v.hidden = v.dataset.view !== route;
  for (const n of $$("#sideNav .nav-item, #bottomNav .nav-item")) n.classList.toggle("active", n.dataset.route === route);
  const search = $("#searchInput");
  if (searchFilterApplies(route)) search.parentElement.hidden = false; else search.parentElement.hidden = true;
  if (app.updateSearchPlaceholder) app.updateSearchPlaceholder();
  if (!initial) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  if (route === "explore") {
    renderExplore(app);
    flushFilterNotice();
    if (!app.explore.statsAt || Date.now() - app.explore.statsAt > 20000) refreshStats();
  }
  else if (route === "library") { renderLibrary(app); loadLibrary(); }
  else if (route === "create") renderCreate(app);
}
function navigate(route) { if (route !== app.route) showRoute(route); }
function searchFilterApplies(route) { return route === "explore" || route === "library"; }

function setSearch(q) {
  app.searchQuery = q;
  if (app.route === "explore") {
    app.explore.query = q;
    loadExplore({ reset: true });
  } else if (app.route === "library") {
    renderLibrary(app);
  }
}

// ===========================================================================
// Engine
// ===========================================================================
function setupEngine() {
  app.engine = new TTSEngine({
    allowWebGpu: !app.settings.slowMode,
    // How far the background prefetch reaches from the playhead (Infinity = the
    // whole book — see PREFETCH_WINDOW in config.js).
    prefetchAhead: PREFETCH_WINDOW.ahead,
    prefetchBehind: PREFETCH_WINDOW.behind,
    // The pool can be unloaded when idle (see tickEngineIdle); anything that
    // queues work on an unloaded engine calls back here to bring it back.
    // The engine needed travels along: Kokoro, Paradee and TITL pools initialise
    // independently, so requesting one never downloads another's model.
    onNeedEngine: (engine) => { ensureEngine(engine || "kokoro").catch(() => {}); },
    onInitProgress: (p) => {
      app.engineStatus.phase = p.phase;
      if (typeof p.progress === "number") app.engineStatus.progress = p.progress;
      updateEngineStatus();
    },
    onDevice: (d) => {
      app.engineStatus.device = d.deviceUsed || app.engineStatus.device;
      app.engineStatus.gpuFailed = !!d.gpuFailed;
      app.engineStatus.hasWebGpu = !!d.hasWebGpu;
      updateEngineStatus();
    },
    onReady: (r) => {
      app.engineStatus.ready = true;
      app.engineStatus.device = r.deviceUsed || app.engineStatus.device;
      app.engineStatus.gpuFailed = !!r.gpuFailed;
      app._ttsActiveAt = Date.now();
      updateEngineStatus();
    },
    onChunk: (info) => { app._ttsActiveAt = Date.now(); if (app.player) app.player.onEngineChunk(info); },
    // Runtime backstop for the default-voice heuristic (see noteEngineSpeed).
    onSpeed: (s) => { noteEngineSpeed(s); },
    onChunkError: (info) => {
      app._ttsActiveAt = Date.now();
      app.failedChunks.add(info.index);
      if (app.player) app.player.onEngineError(info);
      if (app.failedChunks.size === 1) toast("A segment failed to synthesise — retrying may help", { type: "error" });
    },
  });
}

function ensureEngine(engine = "kokoro") {
  if (!app.enginePromises) app.enginePromises = {};
  if (app.enginePromises[engine]) return app.enginePromises[engine];
  app._ttsActiveAt = Date.now();
  app.engineStatus.started = true;
  app.engineStatus.failed = false; // a retry after a past failure shows progress, not the old error
  updateEngineStatus();
  app.enginePromises[engine] = app.engine.init(engine).then(() => {
    const alive = app.engine.poolReady(engine);
    if (!alive) {
      // Don't cache the dead init: the next attempt retries instead of
      // reusing this failure forever (one transient flake used to brick all
      // later previews until a full page reload).
      delete app.enginePromises[engine];
      app.engineStatus.failed = true;
      updateEngineStatus();
      toast("The narration engine couldn't load. Please try again.", { type: "error", timeout: 6000 });
    }
    return true;
  }).catch((e) => {
    console.warn("engine init:", e);
    delete app.enginePromises[engine]; // transient failure retries next time
    app.engineStatus.failed = true;
    updateEngineStatus();
    return false;
  });
  return app.enginePromises[engine];
}

// Runtime backstop for the default-voice heuristic: the heuristic predicts from
// static signals plus a short benchmark, but these are real synthesis
// measurements. If Kokoro sustains less than realtime on this device, suggest
// the Light voice once (persisted, so it never nags).
function noteEngineSpeed({ engine, avg, samples }) {
  if (engine !== "kokoro" || samples < 5 || avg >= MIN_RTF) return;
  if (app._slowKokoroToastShown || app.settings.slowHintShown) return;
  if (isLightVoice(app.settings.voice)) return;
  app._slowKokoroToastShown = true;
  store.setSetting("slowHintShown", true).catch(() => {});
  toast("Narration is running slower than listening speed on this device — the Light narrators (look for “Light & fast” in Settings) are much faster here. You can switch in Settings.", { timeout: 9000 });
}

// Free the worker pool once it has no work left to do. Each wasm worker keeps a
// full copy of the model (~0.25-0.3 GB), so leaving the pool resident after the
// book is done is the biggest memory cost in the app. Whether or not audio is
// currently playing is irrelevant: playback reads already-synthesised blobs and
// never needs a worker, so a fully-computed book releases its pool even
// mid-listen. Only ongoing synthesis (pending/busy/warm work) counts as
// activity. The engine instance survives, so the next job — a voice change, a
// new book, a seek to something not yet cached — just rebuilds it on demand.
const ENGINE_IDLE_UNLOAD_MS = 4 * 60 * 1000;

function tickEngineIdle() {
  if (!app.enginePromises || !Object.keys(app.enginePromises).length) return;
  const eng = app.engine;
  if (!eng || !eng.ready) return;
  if (eng.pendingCount > 0 || eng.busyCount > 0 || eng.warmCount > 0) { app._ttsActiveAt = Date.now(); return; }
  if (Date.now() - (app._ttsActiveAt || 0) < ENGINE_IDLE_UNLOAD_MS) return;
  unloadEngine();
}

function unloadEngine() {
  const eng = app.engine;
  if (!eng || !eng.unload()) return;
  app.enginePromises = null;
  app.engineStatus = { started: false, ready: false, phase: null, progress: 0, device: app.engineStatus.device, gpuFailed: app.engineStatus.gpuFailed, hasWebGpu: app.engineStatus.hasWebGpu, failed: false };
  updateEngineStatus();
}

async function rebuildEngine() {
  const p = app.player;
  const snap = p.book ? { book: p.book, chunks: p.chunks, index: p.currentIndex, offset: p.offset, playing: p.isPlaying } : null;
  if (p.book) p.pause();
  try { app.engine.dispose(); } catch (e) {}
  app.enginePromises = null;
  app.engineStatus = { started: false, ready: false, phase: null, progress: 0, device: null, gpuFailed: false, hasWebGpu: false, failed: false };
  setupEngine();
  p.engine = app.engine;
  ensureEngine(engineForVoice((snap && snap.book && (snap.book.voice || app.settings.voice)) || app.settings.voice));
  if (snap) {
    app.failedChunks.clear();
    p.open(snap.book, snap.chunks, { position: { index: snap.index, offset: snap.offset }, voice: snap.book.voice });
    p.setupMediaSession();
    renderReader(snap.book);
    if (snap.playing) p.play();
    else updatePlayerUI(p.getState());
  }
}

function updateEngineStatus() {
  const hosts = ["#npEngine", "#createEngine"].map((s) => $(s)).filter(Boolean);
  if (!hosts.length) return;
  const s = app.engineStatus;
  let text, warn = false, loading = false, settled = false;
  if (s.failed) { text = "Narration engine failed to load"; warn = true; }
  else if (!s.started) { text = "Ready when you are"; settled = true; }
  else if (!s.ready) {
    loading = true;
    if (s.phase === "selftest") text = "Checking graphics support…";
    else text = "Loading voice model… " + Math.round((s.progress || 0) * 100) + "%";
  } else {
    text = "Narration ready";
    if (s.gpuFailed) { warn = true; text += " · running on CPU"; }
    settled = true;
  }
  for (const host of hosts) {
    host.innerHTML = "";
    host.classList.toggle("ready", settled);
    if (loading) host.appendChild(el("span", { class: "spinner", style: { width: "13px", height: "13px", borderWidth: "2px" } }));
    else host.appendChild(el("span", { class: "dot" + (warn ? " warn" : "") }));
    host.appendChild(el("span", { text }));
  }
}

async function previewVoice(voiceId, btn) {
  const showIdle = () => { if (btn) { btn.disabled = false; btn.classList.remove("playing"); btn.innerHTML = icon("play", { size: 18 }); } };
  try {
    if (app._previewAudio) { try { app._previewAudio.pause(); } catch (e) {} app._previewAudio = null; }
    if (btn) { btn.disabled = true; btn.classList.add("playing"); btn.innerHTML = ""; btn.appendChild(spinnerNode(16)); }
    await ensureEngine(engineForVoice(voiceId));
    let blob = app.previewCache.get(voiceId);
    if (!blob) {
      blob = await app.engine.previewVoice(SAMPLE_TEXT, voiceId);
      app.previewCache.set(voiceId, blob);
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    app._previewAudio = audio;
    audio.onended = () => { URL.revokeObjectURL(url); if (app._previewAudio === audio) app._previewAudio = null; showIdle(); };
    audio.onerror = audio.onended;
    showIdle();
    if (btn) { btn.classList.add("playing"); btn.innerHTML = icon("pause", { size: 18 }); }
    await audio.play();
  } catch (e) {
    toast("Couldn't play that preview", { type: "error" });
    showIdle();
  }
}

// ===========================================================================
// Player
// ===========================================================================
function setupPlayer() {
  app.player = new Player({
    engine: app.engine,
    onState: (s) => updatePlayerUI(s),
    onListen: (dt) => reportListen(dt),
    onBookEnd: () => {
      persistPosition();
      if (app.currentBook) {
        app.currentBook.finished = true;
        store.patchBook(app.currentBook.id, { finished: true }).catch(() => {});
      }
      if (app.bookQueue) advanceBookQueue();
      else if (app.bmQueue) advanceBookmarkQueue();
    },
  });
}

function setupPlayerScreen() {
  $("#npCloseBtn").addEventListener("click", closePlayerScreen);
  $("#npPlayBtn").addEventListener("click", togglePlay);
  $("#npBackBtn").innerHTML = icon("back10", { size: 28 });
  $("#npBackBtn").addEventListener("click", () => { app.player.skip(-10); if (!app.player.isPlaying) persistPosition(); });
  $("#npFwdBtn").innerHTML = icon("fwd30", { size: 28 });
  $("#npFwdBtn").addEventListener("click", () => { app.player.skip(30); if (!app.player.isPlaying) persistPosition(); });
  $("#npRateBtn").addEventListener("click", cycleRate);
  const bmBtn = $("#npBookmarkBtn");
  bmBtn.innerHTML = icon("bookmark", { size: 22 });
  bmBtn.addEventListener("click", bookmarkHere);
  setupBookmarkPopDismiss();
  setupScrubber();
  $("#npThemeBtn").addEventListener("click", toggleTheme);
  $("#npSettingsBtn").innerHTML = icon("sliders", { size: 19 });
  $("#npSettingsBtn").addEventListener("click", openSettings);
  const optsBtn = $("#npOptsBtn");
  optsBtn.innerHTML = icon("moreCircle", { size: 20 });
  optsBtn.addEventListener("click", () => { if (app.currentBook) openBookMenu(app.currentBook); });
  const ret = $("#npScrollReturn");
  ret.innerHTML = "";
  ret.appendChild(el("span", { class: "sr-ic", html: icon("locate", { size: 16 }) }));
  ret.appendChild(el("span", { text: "Return to auto-scroll" }));
  ret.addEventListener("click", () => { app.userScrolledAt = 0; scrollActiveIntoView(true); });
  const textHost = $("#npText");
  textHost.addEventListener("scroll", onReaderScroll, { passive: true });
  paintRateBtn();
  paintQueueBar();
  applyTheme();
  updateScrollReturn();
}

// Distinguishes a deliberate scroll away from the chunk being read from the
// jitter of a tap/selection, so autoscroll only pauses when the reader really
// means to wander off.
function activeChunkOffset() {
  const els = app.chunkEls;
  if (!els || !els.length) return null;
  const node = els[app.player.currentIndex];
  if (!node) return null;
  const host = $("#npText");
  const hr = host.getBoundingClientRect();
  const nr = node.getBoundingClientRect();
  const visible = nr.bottom > hr.top && nr.top < hr.bottom;
  const center = hr.top + hr.height / 2;
  const nodeCenter = nr.top + nr.height / 2;
  return { offset: Math.abs(nodeCenter - center), visible, height: hr.height };
}

let programmaticScrollUntil = 0;
function onReaderScroll() {
  if (Date.now() < programmaticScrollUntil) return; // our own scrollIntoView
  const m = activeChunkOffset();
  if (!m) return;
  if (app.userScrolledAt) {
    // Hysteresis: only resume following once the active chunk is central again.
    if (m.visible && m.offset < Math.max(70, m.height * 0.16)) app.userScrolledAt = 0;
  } else if (!m.visible || m.offset > Math.max(100, m.height * 0.28)) {
    app.userScrolledAt = Date.now();
  }
  updateScrollReturn();
}

function updateScrollReturn() {
  const btn = $("#npScrollReturn");
  if (!btn) return;
  btn.hidden = !(app.playerOpen && app.settings.autoScroll && !!app.userScrolledAt);
}

function paintRateBtn() {
  const btn = $("#npRateBtn");
  if (btn) btn.textContent = (app.settings.rate || 1) + "×";
}

function cycleRate() {
  const i = RATES.indexOf(app.settings.rate);
  const next = RATES[(i + 1) % RATES.length];
  setRate(next);
}

function setRate(next) {
  app.settings.rate = next;
  store.setSetting("rate", next);
  const p = app.player;
  p.rate = next;
  for (const a of p.el) { try { a.playbackRate = next; a.preservesPitch = true; } catch (e) {} }
  paintRateBtn();
}

function setupScrubber() {
  const scrub = $("#npScrub");
  const frac = (e) => {
    const r = scrub.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
  };
  const paint = (f) => {
    $("#npScrubFill").style.width = f * 100 + "%";
    $("#npScrubKnob").style.left = f * 100 + "%";
    const total = app.player.totalDuration();
    $("#npTimeNow").textContent = formatDuration(f * total);
  };
  scrub.addEventListener("pointerdown", (e) => {
    if (!app.player.book) return;
    app.scrubDragging = true;
    scrub.classList.add("dragging");
    try { scrub.setPointerCapture(e.pointerId); } catch (err) {}
    app.scrubFrac = frac(e); paint(app.scrubFrac);
  });
  scrub.addEventListener("pointermove", (e) => {
    if (!app.scrubDragging) return;
    app.scrubFrac = frac(e); paint(app.scrubFrac);
  });
  const end = (e) => {
    if (!app.scrubDragging) return;
    app.scrubDragging = false;
    scrub.classList.remove("dragging");
    app.scrubFrac = frac(e);
    seekToFraction(app.scrubFrac);
    persistPosition();
  };
  scrub.addEventListener("pointerup", end);
  scrub.addEventListener("pointercancel", () => { app.scrubDragging = false; scrub.classList.remove("dragging"); updatePlayerUI(app.player.getState()); });
}

function seekToFraction(f) {
  const p = app.player;
  if (!p.book || !p.total) return;
  let target = f * p.totalDuration();
  let i = 0;
  while (i < p.total - 1 && target > p.chunkDuration(i)) { target -= p.chunkDuration(i); i++; }
  if (app.settings.autoScroll) app.userScrolledAt = 0;
  p.seekToIndex(i, Math.max(0, target));
  // Follow the playhead to the clicked spot in the reader (autoscroll users).
  if (app.settings.autoScroll) scrollActiveIntoView(true);
}

function togglePlay() {
  const p = app.player;
  if (!p.book) return;
  if (!p.isPlaying) { p.play(); reportPlay(app.currentBook); }
  else { p.pause(); persistPosition(); }
}

function openPlayerScreen() {
  const s = $("#playerScreen");
  if (app.playerOpen) return;
  app.playerOpen = true;
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add("open"));
  $("#miniPlayer").hidden = true;
  if (app.player.book) {
    updatePlayerHeader(app.player.book);
    scrollActiveIntoView(true);
  }
  paintQueueBar();
}
function closePlayerScreen() {
  const s = $("#playerScreen");
  app.playerOpen = false;
  s.classList.remove("open");
  setTimeout(() => { if (!app.playerOpen) s.hidden = true; }, 230);
  persistPosition();
  hideBookmarkPop();
  updateScrollReturn();
  if (app.player.book) updateMiniPlayer(app.player.getState());
}

function updatePlayerHeader(book) {
  if (!book) return;
  const titleEl = $("#npTitle");
  const titling = app.titling.has(book.id);
  if (titling) {
    titleEl.innerHTML = escapeHtml(book.title || "Untitled") + ' <span class="title-spin"></span>';
  } else {
    titleEl.textContent = book.title || "Untitled";
  }
  $("#npAuthor").textContent = book.author || "Unknown author";
}

function paintProcedural(host, book, size) {
  paintProceduralCover(host, book);
}

function updateMiniPlayer(s) {
  const mp = $("#miniPlayer");
  if (!mp || !s || !s.book) { if (mp) mp.hidden = true; return; }
  if (app.playerOpen) { mp.hidden = true; return; }
  mp.hidden = false;
  if (!mp._built) buildMiniPlayer(mp);
  if (mp._bookId !== s.book.id) {
    mp._bookId = s.book.id;
    paintCover(mp._cov, s.book);
  }
  mp._title.textContent = s.book.title || "Untitled";
  mp._sub.textContent = [s.book.author, s.buffering && !s.isPlaying ? "buffering…" : formatDuration(s.elapsed) + " / " + formatDuration(s.duration)].filter(Boolean).join(" · ");
  mp._play.innerHTML = icon(s.isPlaying ? "pause" : "play", { size: 20 });
  mp._bar.style.width = Math.min(100, s.progress * 100) + "%";
}

function buildMiniPlayer(mp) {
  mp._built = true;
  mp.innerHTML = "";
  const cov = el("div", { class: "mp-cover" });
  const title = el("div", { class: "mp-title" });
  const sub = el("div", { class: "mp-sub" });
  const info = el("div", { class: "mp-info" }, [title, sub]);
  const back = el("button", { class: "icon-btn mp-t-btn", title: "Back 10 seconds", "aria-label": "Back 10 seconds", html: icon("back10", { size: 19 }) });
  const play = el("button", { class: "icon-btn mp-play", title: "Play/Pause", html: icon("play", { size: 20 }) });
  const fwd = el("button", { class: "icon-btn mp-t-btn", title: "Forward 30 seconds", "aria-label": "Forward 30 seconds", html: icon("fwd30", { size: 19 }) });
  const bar = el("div", { class: "mp-bar" }, [el("i")]);
  mp.append(cov, info, back, play, fwd, bar);
  mp._cov = cov; mp._title = title; mp._sub = sub; mp._play = play; mp._bar = bar.firstChild;
  const stop = (e, fn) => { e.stopPropagation(); fn(); };
  back.addEventListener("click", (e) => stop(e, () => { app.player.skip(-10); if (!app.player.isPlaying) persistPosition(); }));
  play.addEventListener("click", (e) => stop(e, togglePlay));
  fwd.addEventListener("click", (e) => stop(e, () => { app.player.skip(30); if (!app.player.isPlaying) persistPosition(); }));
  mp.addEventListener("click", () => openPlayerScreen());
}

function paintCover(host, book) {
  host.innerHTML = "";
  host.style.background = "";
  const src = covers.coverUrlFor(book);
  if (src) {
    const img = el("img", { src, alt: "" });
    img.addEventListener("error", () => { img.remove(); paintProcedural(host, book, 44); }, { once: true });
    host.appendChild(img);
  } else {
    paintProcedural(host, book, 44);
  }
}

// Reflects the live player state onto any visible book card for the current
// book: highlights it and keeps its progress bar in step with playback (instead
// of freezing at whatever progress the card had when it was rendered).
function syncPlayingCards(s) {
  const id = s && s.book && s.book.id != null ? String(s.book.id) : null;
  const playing = !!(id && s.isPlaying);
  const cards = document.querySelectorAll(".card[data-book-id]");
  for (const card of cards) {
    const isCurrent = id != null && card.dataset.bookId === id;
    card.classList.toggle("current", isCurrent);
    card.classList.toggle("playing", isCurrent && playing);
    if (isCurrent && card._progressBar) {
      card._progressBar.hidden = false;
      card._progressFill.style.width = Math.min(100, Math.max(0, (s.progress || 0) * 100)) + "%";
    }
  }
}

let npUiCache = {};
function updatePlayerUI(s) {
  if (!s) s = app.player.getState();
  syncPlayingCards(s);
  if (!s.book) { updateMiniPlayer(null); return; }
  updateMiniPlayer(s);
  if (!app.playerOpen) return;

  const key = `${s.isPlaying}|${s.buffering}|${s.currentIndex}`;
  if (npUiCache.key !== key) {
    npUiCache.key = key;
    const btn = $("#npPlayBtn");
    if (s.buffering && !s.isPlaying) { btn.innerHTML = ""; btn.appendChild(spinnerNode(30)); }
    else btn.innerHTML = icon(s.isPlaying ? "pause" : "play", { size: 30 });
    const pill = $("#npStatus");
    if (s.buffering && s.isPlaying) {
      pill.hidden = false;
      pill.innerHTML = "";
      pill.appendChild(spinnerNode(13));
      pill.appendChild(el("span", { text: "Buffering segment…" }));
    } else if (app.failedChunks.size && !s.isPlaying) {
      pill.hidden = false;
      pill.textContent = app.failedChunks.size + " segment(s) failed";
    } else pill.hidden = true;
  }

  if (!app.scrubDragging) {
    const pct = Math.min(100, Math.max(0, s.progress * 100));
    $("#npScrubFill").style.width = pct + "%";
    $("#npScrubKnob").style.left = pct + "%";
    $("#npTimeNow").textContent = formatDuration(s.elapsed);
  }
  $("#npTimeTotal").textContent = formatDuration(s.duration);
  $("#npScrubReady").style.width = Math.min(100, (s.readyCount / Math.max(1, s.total)) * 100) + "%";
  applyChunkStates(s.currentIndex, s.buffering);
}

let lastChunkIndex = -1;
let lastChunkBuffering = null;
function applyChunkStates(active, buffering) {
  const els = app.chunkEls;
  if (!els || !els.length) return;
  buffering = !!buffering;
  if (lastChunkIndex === active && lastChunkBuffering === buffering && els._paintedTotal === els.length) return;
  for (let i = 0; i < els.length; i++) {
    const n = els[i];
    const isActive = i === active;
    n.classList.toggle("active", isActive);
    // The chunk the playhead is parked on while its audio is still being
    // produced — i.e. the one holding up playback — gets a pulsing treatment.
    n.classList.toggle("buffering", isActive && buffering);
    n.classList.toggle("done", i < active && !(app.failedChunks.has(i)));
  }
  els._paintedTotal = els.length;
  lastChunkIndex = active;
  lastChunkBuffering = buffering;
  scrollActiveIntoView(false);
}

// Our own reader scroll animation. The browser's native smooth scroll can't be
// cancelled reliably by a following instant scrollTo (a far jump keeps animating,
// so a seek appeared to "not move" until playback caught up), so we drive it with
// rAF and can yank straight to the target when a seek demands it.
let scrollRaf = 0;
let scrollGen = 0;
function animateReaderScroll(host, to, smooth) {
  // Bump the generation so any in-flight smooth step stops on its next frame even
  // if cancelAnimationFrame isn't honoured. (Without this, a far seek's instant
  // jump was overridden by the still-running auto-follow animation.)
  const myGen = ++scrollGen;
  if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
  to = Math.max(0, to);
  if (!smooth) { host.scrollTop = to; return; }
  const from = host.scrollTop;
  const dist = to - from;
  if (Math.abs(dist) < 1.5) { host.scrollTop = to; return; }
  const dur = Math.min(420, 150 + Math.abs(dist) * 0.03);
  const t0 = performance.now();
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const step = (t) => {
    if (myGen !== scrollGen) return; // superseded by a newer scroll request
    const k = Math.min(1, (t - t0) / dur);
    host.scrollTop = from + dist * ease(k);
    scrollRaf = k < 1 ? requestAnimationFrame(step) : 0;
  };
  scrollRaf = requestAnimationFrame(step);
}

function scrollActiveIntoView(force) {
  const els = app.chunkEls;
  if (!els || !els.length) return;

  const idx = app.player.currentIndex;
  const node = els[idx];
  if (!node) return;
  if (!force) {
    if (!app.settings.autoScroll) return;
    if (app.userScrolledAt) return; // reader is deliberately reading elsewhere
  }
  app.userScrolledAt = 0;
  const host = $("#npText");
  const hr = host.getBoundingClientRect();
  const nr = node.getBoundingClientRect();
  const top = Math.max(0, host.scrollTop + (nr.top - hr.top) - (hr.height - nr.height) / 2);
  programmaticScrollUntil = Date.now() + 900;
  animateReaderScroll(host, top, !force);
  if (force) updateScrollReturn(); else setTimeout(updateScrollReturn, 600);
  updateScrollReturn();
}

// A chunk that reads like a section label ("Chapter One", a title line) gets
// real heading treatment in the reader. Purely presentational.
const HEADING_RE = /^(chapter|part|book|act|prologue|epilogue|introduction|prelude|foreword|afterword|interlude|canto|scene)\b/i;
function looksLikeHeading(text) {
  const t = (text || "").trim();
  if (!t || t.length > 56 || /["“”]/.test(t)) return false;
  if (HEADING_RE.test(t)) return true;
  const words = t.split(/\s+/).length;
  return words <= 8 && !/[.!?,;:…]$/.test(t);
}

function renderReader(book) {
  const inner = $("#npTextInner");
  inner.innerHTML = "";
  app.chunkEls = [];
  lastChunkIndex = -1;
  lastChunkBuffering = null;
  book.chunks.forEach((c, i) => {
    const classes = ["chunk"];
    if (c.isStartOfParagraph) classes.push("start");
    if (looksLikeHeading(c.text)) classes.push("heading");
    const p = el("p", { class: classes.join(" "), text: c.text });
    p.addEventListener("click", () => {
      app.player.seekToIndex(i, 0);
      app.userScrolledAt = 0;
      scrollActiveIntoView(true);
      if (!app.player.isPlaying) persistPosition();
    });
    app.chunkEls.push(p);
    inner.appendChild(p);
  });
  app.chunkEls._paintedTotal = -1;
  applyChunkStates(app.player.currentIndex, app.player.buffering);
}

function renderReaderLoading(book) {
  const inner = $("#npTextInner");
  inner.innerHTML = "";
  app.chunkEls = [];
  inner.appendChild(el("div", { class: "hint", style: { marginBottom: "16px" }, text: "Fetching the text…" }));
  for (let i = 0; i < 8; i++) {
    inner.appendChild(el("div", { class: "skeleton", style: { height: "19px", margin: "12px 0", width: (70 + Math.random() * 30) + "%" } }));
  }
}

// ===========================================================================
// Bookmarks
//
// A bookmark is a remembered spot (chunk + seconds) with an optional note and
// free-form tags. Everything is denormalised at save time (bookTitle, snippet,
// absolute seconds) so the library's Bookmarks view renders without touching a
// single book's prose. Tag suggestions are frequency-ranked across the user's
// own bookmarks, so the common case — tap bookmark, tap a familiar tag — costs
// two taps and no typing.
// ===========================================================================
async function loadBookmarks() {
  try { app.bookmarks = await store.listBookmarks(); }
  catch (e) { console.warn(e); app.bookmarks = []; }
  if (app.route === "library") renderLibrary(app);
}
function findBookmark(id) { return (app.bookmarks || []).find((b) => b.id === id) || null; }

function normalizeTag(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 24);
}

function currentSpot() {
  const p = app.player;
  if (!p.book) return null;
  const index = Math.max(0, p.currentIndex | 0);
  const chunk = p.chunks[index];
  return {
    bookId: p.book.id,
    index,
    offset: p.offset || 0,
    sec: p.elapsed(),
    totalSec: p.totalDuration(),
    snippet: truncate(((chunk && chunk.text) || "").replace(/\s+/g, " ").trim(), 90),
    bookTitle: p.book.title || "Untitled",
  };
}

// Tapping the bookmark button twice at the same spot edits the existing mark
// instead of stacking near-duplicates on top of each other.
async function bookmarkHere() {
  const spot = currentSpot();
  if (!spot) { toast("Open an audiobook first", { type: "error" }); return; }
  let bm = (app.bookmarks || []).find((b) => b.bookId === spot.bookId && Math.abs((b.sec || 0) - spot.sec) < 2.5);
  if (!bm) {
    bm = { id: uid(), ...spot, note: "", tags: [], createdAt: Date.now() };
    app.bookmarks.unshift(bm);
    await store.putBookmark(bm);
  }
  const btn = $("#npBookmarkBtn");
  if (btn) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); }
  showBookmarkPop(bm);
}

function tagCounts() {
  const counts = new Map();
  for (const bm of app.bookmarks || []) for (const t of bm.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Frequency-ranked tags the user has already used elsewhere, topped up with the
// current book's own tags — so there is almost always a one-tap answer.
function suggestTags(bm, current = bm.tags || []) {
  const ranked = tagCounts().map((e) => e[0]);
  const book = (app.player.book && app.player.book.id === bm.bookId) ? app.player.book
    : (app.currentBook && app.currentBook.id === bm.bookId) ? app.currentBook : null;
  const tagSuggestions = (((book && book.tags) || []).map(normalizeTag)).filter(Boolean);
  const out = [];
  for (const t of ranked.concat(tagSuggestions)) {
    if (!t || current.includes(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

function saveBookmarkPatch(bm, patch) {
  Object.assign(bm, patch);
  store.patchBookmark(bm.id, patch).catch(() => {});
  if (app.route === "library") renderLibrary(app);
}

// A small, self-contained tag editor: tap a suggestion to add it, tap an
// existing tag to drop it, or type a brand-new one inline.
function tagEditor(initial, onSave, suggestFn = null) {
  let tags = (initial || []).slice();
  const wrap = el("div", { class: "chips tag-edit" });
  const commit = () => { onSave(tags.slice()); paint(); };
  const paint = () => {
    wrap.innerHTML = "";
    for (const t of tags) {
      const c = el("button", { class: "chip active tag-remove", title: "Remove " + t }, [t, el("span", { class: "tag-x", html: icon("close", { size: 12 }) })]);
      c.addEventListener("click", () => { tags = tags.filter((x) => x !== t); commit(); });
      wrap.appendChild(c);
    }
    if (suggestFn) {
      for (const t of suggestFn(tags)) {
        const c = el("button", { class: "chip tag-suggest", title: "Add " + t }, [icon("plus", { size: 13 }), t]);
        c.addEventListener("click", () => { if (!tags.includes(t)) tags = tags.concat(t).slice(0, 8); commit(); });
        wrap.appendChild(c);
      }
    }
    const add = el("button", { class: "chip tag-add" }, [icon("plus", { size: 14 }), "New"]);
    add.addEventListener("click", () => {
      const input = el("input", { class: "input tag-input", placeholder: "tag name", maxlength: "24", autocapitalize: "off", spellcheck: "false" });
      const commitNew = () => {
        const v = normalizeTag(input.value);
        if (v && !tags.includes(v)) { tags = tags.concat(v).slice(0, 8); commit(); }
        else paint();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commitNew(); }
        else if (e.key === "Escape") { e.stopPropagation(); paint(); }
      });
      input.addEventListener("blur", () => setTimeout(commitNew, 120));
      add.replaceWith(input);
      input.focus();
    });
    wrap.appendChild(add);
  };
  paint();
  return wrap;
}

// --- the transient popup ----------------------------------------------------
let bmPopTimer = null;
function bumpBmPop() {
  clearTimeout(bmPopTimer);
  bmPopTimer = setTimeout(hideBookmarkPop, 8000);
}
function hideBookmarkPop() {
  clearTimeout(bmPopTimer);
  const pop = $("#bmPop");
  if (!pop || pop.hidden) return;
  pop.classList.remove("show");
  setTimeout(() => { if (!pop.classList.contains("show")) { pop.hidden = true; pop.innerHTML = ""; } }, 220);
}
function setupBookmarkPopDismiss() {
  document.addEventListener("pointerdown", (e) => {
    const pop = $("#bmPop");
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target)) return;
    if (e.target.closest && e.target.closest("#npBookmarkBtn")) return;
    hideBookmarkPop();
  });
}

function showBookmarkPop(bm) {
  const pop = $("#bmPop");
  if (!pop) return;
  pop.innerHTML = "";
  pop.hidden = false;
  requestAnimationFrame(() => pop.classList.add("show"));

  pop.appendChild(el("div", { class: "bm-pop-head" }, [
    el("span", { class: "bm-pop-ic", html: icon("bookmarkFill", { size: 16 }) }),
    el("span", { text: "Bookmarked · " + formatDuration(bm.sec) }),
  ]));

  const note = el("input", { class: "input", placeholder: "Add a note (optional)", maxlength: "140", autocomplete: "off", value: bm.note || "" });
  let noteTimer = null;
  note.addEventListener("input", () => {
    bumpBmPop();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveBookmarkPatch(bm, { note: note.value.trim() }), 400);
  });
  note.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveBookmarkPatch(bm, { note: note.value.trim() }); hideBookmarkPop(); }
  });
  pop.appendChild(note);

  const tagsWrap = el("div", { class: "bm-tags" });
  tagsWrap.appendChild(tagEditor(bm.tags || [], (tags) => saveBookmarkPatch(bm, { tags }), (current) => suggestTags(bm, current)));
  pop.appendChild(tagsWrap);

  pop.addEventListener("pointerdown", bumpBmPop);
  bumpBmPop();
}

// --- playback queues --------------------------------------------------------
async function playBookmarkQueue(ids, { label = null, startAt = 0 } = {}) {
  const list = (ids || []).filter((id) => findBookmark(id));
  if (!list.length) { toast("No bookmarks to play", { type: "error" }); return; }
  app.bmQueue = { ids: list, pos: -1, label };
  await jumpToQueueItem(Math.max(0, Math.min(startAt | 0, list.length - 1)));
}

async function jumpToQueueItem(pos) {
  const q = app.bmQueue;
  if (!q) return;
  if (pos < 0 || pos >= q.ids.length) { exitBookmarkQueue(); return; }
  q.pos = pos;
  const bm = findBookmark(q.ids[pos]);
  if (!bm) { if (pos < q.ids.length - 1) return jumpToQueueItem(pos + 1); exitBookmarkQueue(); return; }
  paintQueueBar();
  await openBookmarkSpot(bm, { autoplay: true });
}

async function openBookmarkSpot(bm, { autoplay = true } = {}) {
  const book = await store.getBook(bm.bookId);
  if (!book) { toast("That audiobook is no longer in your library", { type: "error" }); return false; }
  if (!app.player.book || app.player.book.id !== bm.bookId) {
    app._queueOpening = true;
    try { await openBook(book, { position: { index: bm.index, offset: bm.offset } }); }
    finally { app._queueOpening = false; }
  }
  app.player.seekToIndex(bm.index, bm.offset);
  app.userScrolledAt = 0;
  if (app.playerOpen) scrollActiveIntoView(true);
  if (autoplay) { app.player.play(); reportPlay(app.currentBook); }
  return true;
}

function advanceBookmarkQueue() {
  const q = app.bmQueue;
  if (!q) return;
  if (q.pos < q.ids.length - 1) jumpToQueueItem(q.pos + 1);
  else exitBookmarkQueue(true);
}

function exitBookmarkQueue(finished = false) {
  if (!app.bmQueue) return;
  app.bmQueue = null;
  paintQueueBar();
  if (finished) toast("Finished the bookmark queue");
}

// --- collection queue -------------------------------------------------------
// A collection plays back like a queue: jumpToBookQueue opens each book in turn
// and the player's onBookEnd advances to the next one.
async function playCollection(collectionId) {
  const list = sortByOrder((app.library || []).filter((b) => (b.collectionId ?? null) === (collectionId ?? null) && !b.archived));
  if (!list.length) { toast("This collection is empty", { type: "error" }); return; }
  exitBookmarkQueue();
  app.bookQueue = { ids: list.map((b) => b.id), pos: -1, label: collectionName(collectionId) };
  await jumpToBookQueue(0);
}

async function jumpToBookQueue(pos) {
  const q = app.bookQueue;
  if (!q) return;
  if (pos < 0 || pos >= q.ids.length) { exitBookQueue(); return; }
  q.pos = pos;
  const book = await store.getBook(q.ids[pos]);
  if (!book) { if (pos < q.ids.length - 1) return jumpToBookQueue(pos + 1); exitBookQueue(); return; }
  paintQueueBar();
  app._bookQueueOpening = true;
  try { await openBook(book, { autoplay: true }); }
  finally { app._bookQueueOpening = false; }
}

function advanceBookQueue() {
  const q = app.bookQueue;
  if (!q) return;
  if (q.pos < q.ids.length - 1) jumpToBookQueue(q.pos + 1);
  else exitBookQueue(true);
}

function exitBookQueue(finished = false) {
  if (!app.bookQueue) return;
  app.bookQueue = null;
  paintQueueBar();
  if (finished) toast("Finished the collection");
}

function paintQueueBar() {
  const bar = $("#npQueueBar");
  if (!bar) return;
  const bq = app.bookQueue && app.bookQueue.ids.length ? app.bookQueue : null;
  const mq = !bq && app.bmQueue && app.bmQueue.ids.length ? app.bmQueue : null;
  const q = bq || mq;
  if (!q) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  bar.innerHTML = "";
  bar.appendChild(el("span", { class: "nq-ic", html: icon(bq ? "list" : "bookmarkFill", { size: 15 }) }));
  bar.appendChild(el("span", { class: "nq-label", text: (q.label ? q.label + " · " : "") + (q.pos + 1) + " of " + q.ids.length }));
  if (mq) {
    const bm = findBookmark(q.ids[q.pos]);
    if (bm) {
      bar.appendChild(el("span", { class: "nq-time", text: "· " + formatDuration(bm.sec) }));
      bar.appendChild(el("span", { class: "nq-sub", text: bm.bookTitle }));
    }
  } else {
    const book = (app.library || []).find((b) => b.id === q.ids[q.pos]);
    if (book) bar.appendChild(el("span", { class: "nq-sub", text: book.author || "Unknown author" }));
  }
  const tools = el("div", { class: "nq-tools" });
  const prev = el("button", { class: "icon-btn nq-btn", title: "Previous", "aria-label": "Previous", html: icon("chevronLeft", { size: 18 }) });
  if (q.pos <= 0) prev.disabled = true;
  prev.addEventListener("click", () => (bq ? jumpToBookQueue(q.pos - 1) : jumpToQueueItem(q.pos - 1)));
  const next = el("button", { class: "icon-btn nq-btn", title: "Next", "aria-label": "Next", html: icon("chevronRight", { size: 18 }) });
  if (q.pos >= q.ids.length - 1) next.disabled = true;
  next.addEventListener("click", () => (bq ? jumpToBookQueue(q.pos + 1) : jumpToQueueItem(q.pos + 1)));
  const stop = el("button", { class: "icon-btn nq-btn", title: "Stop", "aria-label": "Stop the queue", html: icon("close", { size: 17 }) });
  stop.addEventListener("click", () => (bq ? exitBookQueue() : exitBookmarkQueue()));
  tools.append(prev, next, stop);
  bar.appendChild(tools);
}

// --- per-bookmark options & tag management ----------------------------------
function openBookmarkMenu(bm) {
  const body = el("div");
  const hero = el("div", { class: "share-hero" });
  hero.appendChild(el("div", { class: "bm-hero-cover", style: { background: coverStyle(bm.bookId) } }));
  const info = el("div");
  info.appendChild(el("b", { text: bm.bookTitle || "Untitled" }));
  info.appendChild(el("div", { class: "hint", text: formatDuration(bm.sec) + (bm.totalSec ? " of " + formatDuration(bm.totalSec) : "") }));
  hero.appendChild(info);
  body.appendChild(hero);
  if (bm.snippet) body.appendChild(el("p", { class: "bm-quote", text: "“" + bm.snippet + "”" }));

  const noteField = el("div", { class: "field", style: { marginTop: "14px" } });
  noteField.appendChild(el("label", { text: "Note" }));
  const note = el("textarea", { class: "textarea", style: { minHeight: "70px" }, maxlength: "200", placeholder: "Why did you save this spot?", autocomplete: "off" });
  note.value = bm.note || "";
  let nt = null;
  note.addEventListener("input", () => { clearTimeout(nt); nt = setTimeout(() => saveBookmarkPatch(bm, { note: note.value.trim() }), 400); });
  noteField.appendChild(note);
  body.appendChild(noteField);

  const tagField = el("div", { class: "field", style: { marginTop: "14px" } });
  tagField.appendChild(el("label", { text: "Tags" }));
  tagField.appendChild(tagEditor(bm.tags || [], (tags) => saveBookmarkPatch(bm, { tags }), (current) => suggestTags(bm, current)));
  body.appendChild(tagField);

  const opts = [
    { icon: "play", title: "Play from here", desc: "Jump straight to this spot.", onClick: () => openBookmarkSpot(bm) },
  ];
  const tag = (bm.tags || [])[0];
  if (tag) {
    const ids = (app.bookmarks || []).filter((b) => (b.tags || []).includes(tag)).map((b) => b.id);
    opts.push({ icon: "playAll", title: "Play “" + tag + "”", desc: "Play all " + ids.length + " bookmarks tagged “" + tag + "” back to back.", onClick: () => playBookmarkQueue(ids, { label: "#" + tag }) });
  }
  opts.push({ icon: "trash", title: "Delete", desc: "Remove this saved spot.", danger: true, onClick: () => {
    app.bookmarks = (app.bookmarks || []).filter((b) => b.id !== bm.id);
    store.removeBookmark(bm.id).catch(() => {});
    if (app.bmQueue) app.bmQueue.ids = app.bmQueue.ids.filter((id) => id !== bm.id);
    if (app.route === "library") renderLibrary(app);
    paintQueueBar();
    toast("Bookmark removed");
  } });
  body.appendChild(buildOpts(opts));
  openModal({ title: "Bookmark", body });
}

function openTagManager() {
  const body = el("div");
  const tags = tagCounts();
  if (!tags.length) {
    body.appendChild(el("p", { class: "hint", text: "No tags yet — add one while bookmarking, or from a bookmark's options." }));
    openModal({ title: "Tags", body });
    return;
  }
  body.appendChild(el("p", { class: "hint", text: "Rename a tag everywhere it appears, or remove it from every bookmark." }));
  const list = el("div", { class: "opt-list tag-mgr" });
  for (const [t, n] of tags) {
    const row = el("div", { class: "tag-mgr-row" });
    row.appendChild(el("span", { class: "tag-mgr-ic", html: icon("tag", { size: 16 }) }));
    row.appendChild(el("span", { class: "tag-mgr-name", text: t }));
    row.appendChild(el("span", { class: "hint", text: n === 1 ? "1 bookmark" : n + " bookmarks" }));
    const edit = el("button", { class: "icon-btn", title: "Rename", "aria-label": "Rename tag", html: icon("pencil", { size: 15 }) });
    edit.addEventListener("click", () => renameBookmarkTag(t));
    const del = el("button", { class: "icon-btn", title: "Delete", "aria-label": "Delete tag", html: icon("trash", { size: 15 }) });
    del.addEventListener("click", () => deleteBookmarkTag(t, n));
    row.append(edit, del);
    list.appendChild(row);
  }
  body.appendChild(list);
  openModal({ title: "Tags", body });
}

function renameBookmarkTag(tag) {
  const body = el("div");
  const input = el("input", { class: "input", value: tag, maxlength: "24", autocapitalize: "off", spellcheck: "false" });
  body.appendChild(el("div", { class: "field" }, [el("label", { text: "Rename tag" }), input]));
  openModal({
    title: "Rename tag", body,
    actions: [
      { label: "Cancel", class: "btn-ghost", onClick: closeModal },
      { label: "Save", class: "btn-primary", onClick: async () => {
        const v = normalizeTag(input.value);
        if (!v) { input.focus(); return; }
        closeModal();
        if (v === tag) return;
        await retagEverywhere(tag, v);
        toast("Tag renamed to “" + v + "”");
      } },
    ],
  });
  setTimeout(() => { input.focus(); input.select(); }, 80);
}

function deleteBookmarkTag(tag, count) {
  openModal({
    title: "Delete tag?",
    body: "“" + tag + "” will be removed from " + (count === 1 ? "1 bookmark" : count + " bookmarks") + ". The bookmarks themselves are kept.",
    actions: [
      { label: "Keep", class: "btn-ghost", onClick: closeModal },
      { label: "Delete tag", class: "btn-danger", onClick: async () => { closeModal(); await retagEverywhere(tag, null); toast("Tag deleted"); } },
    ],
  });
}

async function retagEverywhere(from, to) {
  for (const bm of app.bookmarks || []) {
    if (!(bm.tags || []).includes(from)) continue;
    let tags = bm.tags.filter((x) => x !== from);
    if (to && !tags.includes(to)) tags = tags.concat(to).slice(0, 8);
    bm.tags = tags;
    await store.patchBookmark(bm.id, { tags });
  }
  if (app.libraryView.bookmarkTag === from) app.libraryView.bookmarkTag = to || null;
  if (app.route === "library") renderLibrary(app);
}

function setLibraryBookmarks(on) {
  const next = !!on;
  app.libraryView.bookmarks = next;
  if (next) { app.libraryView.showArchived = false; app.libraryView.collectionId = null; }
  else app.libraryView.bookmarkTag = null;
  if (app.route === "library") renderLibrary(app);
}

function setBookmarkTag(tag) {
  app.libraryView.bookmarkTag = tag || null;
  app.libraryView.bookmarks = true;
  if (app.route !== "library") showRoute("library");
  else renderLibrary(app);
}

// --- listening / positions --------------------------------------------------
function reportPlay(book) {
  if (!book) return;
  book.plays = (book.plays || 0) + 1;
  if (book.seq != null && app.net) app.net.play(book.seq).catch(() => {});
}
function reportListen(dt) {
  const b = app.currentBook;
  if (!b || !(dt > 0)) return;
  b.listenSec = (b.listenSec || 0) + dt;
  if (b.seq != null && app.net) {
    app.listenPending += dt;
    if (app.listenPending >= 10) {
      const secs = Math.floor(app.listenPending);
      app.listenPending -= secs;
      app.net.report(b.seq, secs).catch(() => {});
    }
  }
}
let persistTimer = null;
function persistPosition() {
  const p = app.player;
  if (!p || !p.book) return;
  const s = p.getState();
  const payload = {
    index: s.currentIndex, offset: s.offset, progress: s.progress,
    listenSec: Math.round(p.book.listenSec || 0), updatedAt: Date.now(),
  };
  store.savePosition(p.book.id, payload).then(() => {
    if (app.positions) app.positions[p.book.id] = payload;
  }).catch(() => {});
  if (s.progress >= 0.98) maybeMarkFinished(p.book);
}

// Near the end counts as finished — readers often skip the last credits, so we
// don't force them to listen to 100% to clear a book from "unread".
function maybeMarkFinished(book) {
  if (!book || book.finished) return;
  book.finished = true;
  if (app.currentBook && app.currentBook.id === book.id) app.currentBook.finished = true;
  if (app.player.book && app.player.book.id === book.id) app.player.book.finished = true;
  const lib = (app.library || []).find((b) => b.id === book.id);
  if (lib) lib.finished = true;
  store.patchBook(book.id, { finished: true }).catch(() => {});
}

// ===========================================================================
// Tools (transport extras)
// ===========================================================================
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const FONTS = [0.9, 1, 1.15, 1.3, 1.5];

async function downloadBook(book) {
  if (!book || !book.id) return;
  if (!(app.player.book && app.player.book.id === book.id && app.player.total)) {
    await openBook(book);
    if (!(app.player.book && app.player.book.id === book.id)) return;
  }
  downloadCurrentBook();
}

async function downloadCurrentBook() {
  const p = app.player;
  if (!p.book || !p.total) return;
  const book = p.book;
  const total = p.total;
  const bar = el("div", { class: "pub-bar" }, [el("i")]);
  const detail = el("div", { class: "hint" });
  const body = el("div");
  body.appendChild(el("p", { text: "Synthesising the full audiobook, then saving it as a single MP3. You can keep listening while this runs." }));
  body.appendChild(bar);
  body.appendChild(detail);
  openModal({ title: "Download: " + (book.title || "Untitled"), body, actions: [{ label: "Cancel", class: "btn-ghost", onClick: () => { app._downloadCancel = true; closeModal(); } }] });
  app._downloadCancel = false;
  const t0 = Date.now();
  while (p.book === book && p.blobs.size + app.failedChunks.size < total) {
    if (app._downloadCancel) return;
    detail.textContent = `Segment ${Math.min(total, p.blobs.size + app.failedChunks.size)} of ${total} · ${Math.round((p.blobs.size / total) * 100)}%`;
    bar.firstChild.style.width = ((p.blobs.size + app.failedChunks.size) / total) * 100 + "%";
    if (Date.now() - t0 > 60 * 60 * 1000) { closeModal(); toast("Download timed out", { type: "error" }); return; }
    await sleep(500);
  }
  if (app._downloadCancel || p.book !== book) return;
  const blobs = [];
  for (let i = 0; i < total; i++) {
    const rec = p.blobs.get(i);
    if (rec) blobs.push(rec.blob);
  }
  if (!blobs.length) { closeModal(); toast("Nothing to download", { type: "error" }); return; }
  detail.textContent = "Merging audio…";
  const mp3 = await joinMp3Blobs(blobs, (frac) => {
    detail.textContent = "Merging audio… " + Math.round(frac * 100) + "%";
    bar.firstChild.style.width = (frac * 100).toFixed(1) + "%";
  });
  closeModal();
  const safe = (book.title || "audiobook").replace(/[^\w\-. ]+/g, "").trim().slice(0, 60) || "audiobook";
  downloadBlob(mp3, safe + ".mp3");
  toast("Saved " + safe + ".mp3");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

// ===========================================================================
// Library
// ===========================================================================
async function loadLibrary() {
  try {
    app.library = await store.listLibrary();
  } catch (e) {
    console.warn(e);
    app.library = [];
  }
  // Build object URLs for covers kept on this device (a cover is only uploaded
  // when the book is shared, so locally-added ones live in storage as blobs).
  await covers.hydrateAll(app.library);
  const positions = {};
  const limit = Math.min(app.library.length, 200);
  for (let i = 0; i < limit; i++) {
    const b = app.library[i];
    const pos = await store.getPosition(b.id);
    if (pos) positions[b.id] = pos;
  }
  app.positions = positions;
  if (app.route === "library") renderLibrary(app);
}

async function loadCollections() {
  try { app.collections = await store.listCollections(); }
  catch (e) { console.warn(e); app.collections = []; }
  if (app.route === "library") renderLibrary(app);
}

function setCollection(id) {
  app.libraryView.collectionId = id ?? null;
  app.libraryView.bookmarks = false;
  if (app.route === "library") renderLibrary(app);
}
function setLibraryArchived(on) {
  app.libraryView.showArchived = !!on;
  if (on) app.libraryView.bookmarks = false;
  if (app.route === "library") renderLibrary(app);
}

function setLibraryFilter(patch) {
  Object.assign(app.libraryView, patch);
  if (app.route === "library") renderLibrary(app);
}

function toggleLibraryTag(tag) {
  const list = app.libraryView.tagFilter || [];
  const i = list.indexOf(tag);
  if (i >= 0) list.splice(i, 1); else list.push(tag);
  if (app.route === "library") renderLibrary(app);
}

function clearLibraryFilters() {
  app.libraryView.readFilter = "all";
  app.libraryView.tagFilter = [];
  app.libraryView.filterOpen = false;
  if (app.route === "library") renderLibrary(app);
}

function collectionName(id) {
  if (id == null) return "My Library";
  const c = (app.collections || []).find((f) => f.id === id);
  return c ? (c.name || "Folder") : "My Library";
}

// Collections double as playback queues: each book carries an `order` within
// its collection, so the same data gives a tidy folder and a playable list.
function nextOrder(collectionId) {
  const cid = collectionId ?? null;
  let max = -1;
  for (const b of app.library || []) {
    if ((b.collectionId ?? null) !== cid) continue;
    if (typeof b.order === "number" && b.order > max) max = b.order;
  }
  return max + 1;
}

function sortByOrder(list) {
  return list.slice().sort((a, b) => {
    const ao = a.order == null ? Number.MAX_SAFE_INTEGER : a.order;
    const bo = b.order == null ? Number.MAX_SAFE_INTEGER : b.order;
    if (ao !== bo) return ao - bo;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

// Bring an Explore listing into the local library (downloading its text) so it
// can be organised, queued and narrated offline.
async function ensureLocalBook(book) {
  if (!book || !book.id) return null;
  await share.ensureBundle(book);
  const existing = await store.getBook(book.id);
  if (existing) return existing;
  let text = book.text || null;
  if (!text && book.textUrl) {
    try { text = await share.fetchText(book.textUrl); }
    catch (e) { toast("Couldn't fetch that audiobook's text", { type: "error" }); return null; }
  }
  if (!text) { toast("That audiobook has no text", { type: "error" }); return null; }
  const rec = Object.assign({}, book, {
    text,
    origin: book.origin || "explore",
    createdAt: book.createdAt || Date.now(),
    addedAt: Date.now(),
    collectionId: null,
    order: null,
  });
  rec.wordCount = rec.wordCount || wordCount(text);
  await store.putBook(rec);
  await loadLibrary();
  return rec;
}

// "Add to collection" is the same operation whether the book is already in the
// library or still an Explore listing that needs importing first.
async function addBookToCollection(book, collectionId) {
  const local = await ensureLocalBook(book);
  if (!local) return;
  if ((local.collectionId ?? null) === (collectionId ?? null)) {
    toast("Already in " + collectionName(collectionId));
    return;
  }
  await store.patchBook(local.id, { collectionId: collectionId ?? null, order: nextOrder(collectionId) });
  if (book !== local) Object.assign(book, { collectionId: collectionId ?? null, order: local.order });
  await loadLibrary();
  toast("Added to " + collectionName(collectionId));
}

// Reorder a book within its collection (used by the ↑/↓ context-menu items and
// drag-and-drop reordering in the folder view).
async function reorderBook(book, dir) {
  const cid = book.collectionId ?? null;
  if (cid == null) return;
  const list = sortByOrder((app.library || []).filter((b) => (b.collectionId ?? null) === cid));
  const i = list.findIndex((b) => b.id === book.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
  await Promise.all(list.map((b, idx) => store.patchBook(b.id, { order: idx })));
  await loadLibrary();
}

async function movePosition(bookId, newIndex) {
  const book = (app.library || []).find((b) => b.id === bookId);
  if (!book) return;
  const cid = book.collectionId ?? null;
  if (cid == null) return;
  const list = sortByOrder((app.library || []).filter((b) => (b.collectionId ?? null) === cid));
  const from = list.findIndex((b) => b.id === bookId);
  if (from < 0) return;
  const clamped = Math.max(0, Math.min(list.length - 1, newIndex | 0));
  if (clamped === from) return;
  const [moved] = list.splice(from, 1);
  list.splice(clamped, 0, moved);
  await Promise.all(list.map((b, idx) => store.patchBook(b.id, { order: idx })));
  await loadLibrary();
}

async function moveFolder(col, parentId) {
  if (col.id === parentId) return;
  if (parentId != null && isAncestor(col.id, parentId)) { toast("A folder can't go inside itself", { type: "error" }); return; }
  await store.putCollection({ ...col, parentId: parentId ?? null });
  await loadCollections();
  toast("Moved " + (col.name || "folder") + " to " + collectionName(parentId));
}
function isAncestor(ancestorId, nodeId) {
  const byId = new Map((app.collections || []).map((c) => [c.id, c]));
  let cur = nodeId, guard = 0;
  while (cur != null && byId.has(cur) && guard++ < 64) {
    if (cur === ancestorId) return true;
    cur = byId.get(cur).parentId ?? null;
  }
  return false;
}
function handleDrop(targetCollectionId) {
  const drag = app.libraryView.drag;
  app.libraryView.drag = null;
  if (!drag) return;
  if (drag.type === "book") {
    const book = (app.library || []).find((b) => b.id === drag.id);
    if (book) addBookToCollection(book, targetCollectionId);
  } else if (drag.type === "folder") {
    const col = (app.collections || []).find((c) => c.id === drag.id);
    if (col) moveFolder(col, targetCollectionId);
  }
}

function newFolder(parentId = null, thenAdd = null) {
  const body = el("div");
  body.appendChild(el("p", { class: "hint", text: parentId ? "Create a folder inside “" + collectionName(parentId) + "”." : "Folders keep your library tidy — nest them as deep as you like, and play them back like a queue." }));
  const input = el("input", { class: "input", placeholder: "Folder name", maxlength: "60" });
  body.appendChild(el("div", { class: "field", style: { marginTop: "12px" } }, [el("label", { text: "Name" }), input]));
  openModal({
    title: "New collection", body,
    actions: [
      { label: "Cancel", class: "btn-ghost", onClick: closeModal },
      { label: "Create", class: "btn-primary", onClick: async () => {
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        const id = uid();
        await store.putCollection({ id, name, parentId: parentId ?? null, createdAt: Date.now() });
        closeModal();
        await loadCollections();
        toast("Created “" + name + "”");
        if (thenAdd) addBookToCollection(thenAdd, id);
      } },
    ],
  });
  setTimeout(() => input.focus(), 80);
}

// A compact row of pill-shaped actions (icon + short label) shared by every
// options modal. Full-width rows with descriptions were more chrome than the
// actions needed; a tooltip keeps the explanation available on hover.
function buildOpts(items) {
  const opts = el("div", { class: "opt-list" });
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { opts.appendChild(el("div", { class: "opt-sep" })); continue; }
    const o = el("div", {
      class: "opt" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : ""),
      title: it.desc || it.title || "", role: "button", tabindex: "0",
    });
    o.appendChild(el("span", { class: "opt-ic", html: icon(it.icon, { size: 16 }) }));
    o.appendChild(el("b", { text: it.title }));
    const run = () => { if (it.disabled) return; if (!it.keepOpen) closeModal(); it.onClick(); };
    o.addEventListener("click", run);
    o.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); } });
    opts.appendChild(o);
  }
  return opts;
}

function folderMenu(col) {
  const body = el("div");
  const hero = el("div", { class: "share-hero" });
  hero.appendChild(el("div", { class: "folder-ic lg", html: icon("folder", { size: 30 }) }));
  const info = el("div");
  info.appendChild(el("b", { text: col.name || "Folder" }));
  const books = sortByOrder((app.library || []).filter((b) => (b.collectionId ?? null) === col.id && !b.archived));
  info.appendChild(el("div", { class: "hint", text: books.length === 1 ? "1 audiobook" : books.length + " audiobooks" }));
  hero.appendChild(info);
  body.appendChild(hero);

  const opts = [
    books.length ? { icon: "headphones", title: "Play all", desc: "Listen to this collection as a queue.", onClick: () => playCollection(col.id) } : null,
    { icon: "edit", title: "Rename", desc: "Give this collection a different name.", onClick: () => renameFolder(col) },
    { icon: "folderPlus", title: "New subfolder", desc: "Create a collection inside this one.", onClick: () => newFolder(col.id) },
    { icon: "trash", title: "Delete", desc: "The audiobooks inside are kept and moved up a level.", danger: true, onClick: () => confirmDeleteFolder(col) },
  ];
  body.appendChild(buildOpts(opts));
  openModal({ title: "Collection", body });
}

// Right-click (desktop) and long-press (touch) popup for a collection tile —
// the folder counterpart of bookContextMenu. The ⋯ button still opens the full
// modal; "More options…" at the bottom of this popup does too.
function folderContextMenu(col, { x = 0, y = 0 } = {}) {
  const books = sortByOrder((app.library || []).filter((b) => (b.collectionId ?? null) === col.id && !b.archived));
  const items = [];
  items.push({ icon: "folder", label: "Open", onClick: () => setCollection(col.id) });
  if (books.length) items.push({ icon: "headphones", label: "Play all", onClick: () => playCollection(col.id) });
  items.push({ separator: true });
  items.push({ icon: "folderPlus", label: "New subfolder", onClick: () => newFolder(col.id) });
  items.push({ icon: "edit", label: "Rename…", onClick: () => renameFolder(col) });
  items.push({ icon: "trash", label: "Delete", danger: true, onClick: () => confirmDeleteFolder(col) });
  items.push({ separator: true });
  items.push({ icon: "list", label: "More options…", onClick: () => folderMenu(col) });
  openContextMenu(items, { x, y });
}

function renameFolder(col) {
  const body = el("div");
  const input = el("input", { class: "input", value: col.name || "", maxlength: "60" });
  body.appendChild(el("div", { class: "field" }, [el("label", { text: "Name" }), input]));
  openModal({
    title: "Rename collection", body,
    actions: [
      { label: "Cancel", class: "btn-ghost", onClick: closeModal },
      { label: "Save", class: "btn-primary", onClick: async () => {
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        await store.putCollection({ ...col, name });
        closeModal();
        await loadCollections();
      } },
    ],
  });
  setTimeout(() => { input.focus(); input.select(); }, 80);
}

function confirmDeleteFolder(col) {
  openModal({
    title: "Delete collection?",
    body: "“" + (col.name || "Collection") + "” will be removed. Anything inside it moves up a level — nothing is deleted.",
    actions: [
      { label: "Keep", class: "btn-ghost", onClick: closeModal },
      { label: "Delete", class: "btn-danger", onClick: async () => {
        closeModal();
        await store.removeCollection(col.id, { books: app.library, collections: app.collections });
        if (app.libraryView.collectionId === col.id) app.libraryView.collectionId = col.parentId ?? null;
        await Promise.all([loadCollections(), loadLibrary()]);
        toast("Collection deleted");
      } },
    ],
  });
}

function openBookMenu(book) {
  const body = el("div");
  const hero = el("div", { class: "share-hero" });
  hero.appendChild(coverNode(book));
  const meta = el("div", { class: "menu-meta" });
  meta.appendChild(el("div", { class: "menu-title-row" }, [
    el("b", { class: "menu-title", text: book.title || "Untitled" }),
    pencilBtn("Rename title and author", () => renameBook(book)),
  ]));
  meta.appendChild(el("div", { class: "menu-author-row" }, [
    el("span", { class: "menu-author", text: book.author || "Unknown author" }),
    pencilBtn("Rename title and author", () => renameBook(book)),
  ]));
  const pos = app.positions[book.id];
  meta.appendChild(el("div", { class: "menu-narrator-row" }, [
    el("span", { class: "hint", text: "Narrator: " + voiceLabel(bookVoice(book)) + (book.voice ? "" : " (default)") }),
    pencilBtn("Change narrator", () => openVoicePicker(book, { onClose: () => openBookMenu(book) })),
  ]));
  if (pos && pos.listenSec) meta.appendChild(el("div", { class: "hint", text: formatLongDuration(pos.listenSec) + " listened" }));
  hero.appendChild(meta);
  body.appendChild(hero);

  // --- tags -----------------------------------------------------------------
  const tagsField = el("div", { class: "field", style: { marginTop: "2px" } });
  const tagsRow = el("div", { class: "chips tag-edit" });
  let picking = false;
  const paintTags = () => {
    tagsRow.innerHTML = "";
    const tags = book.tags || [];
    for (const g of tags) {
      const c = el("button", { class: "chip active tag-remove", title: "Remove " + g }, [g, el("span", { class: "tag-x", html: icon("close", { size: 12 }) })]);
      c.addEventListener("click", () => saveTags(tags.filter((x) => x !== g)));
      tagsRow.appendChild(c);
    }
    const add = el("button", { class: "chip tag-add" }, [icon(picking ? "chevronDown" : "plus", { size: 14 }), "Add tag"]);
    add.addEventListener("click", () => { picking = !picking; paintTags(); });
    tagsRow.appendChild(add);
    if (picking) {
      const pickWrap = el("div", { class: "tag-pick-wrap" });
      const filterIn = el("input", { class: "input", type: "search", placeholder: "Filter tags…", autocomplete: "off" });
      const pick = el("div", { class: "chips tag-pick" });
      const paintPick = () => {
        const q = filterIn.value.trim().toLowerCase();
        pick.innerHTML = "";
        for (const g of TAGS) {
          if (tags.includes(g)) continue;
          if (q && !g.toLowerCase().includes(q)) continue;
          pick.appendChild(el("button", { class: "chip", onclick: () => saveTags(tags.concat(g).slice(0, MAX_TAGS_PER_BOOK)) }, [g]));
        }
      };
      filterIn.addEventListener("input", paintPick);
      paintPick();
      pickWrap.append(filterIn, pick);
      tagsRow.appendChild(pickWrap);
    }
  };
  const saveTags = async (tags) => {
    book.tags = tags;
    book.tagBits = tagBitsFromNames(tags);
    await store.patchBook(book.id, { tags, tagBits: book.tagBits });
    if (app.currentBook && app.currentBook.id === book.id) { app.currentBook.tags = tags; app.currentBook.tagBits = book.tagBits; }
    picking = false;
    paintTags();
    loadLibrary();
  };
  paintTags();
  tagsField.appendChild(tagsRow);
  body.appendChild(tagsField);

  const local = (app.library || []).some((b) => b.id === book.id);
  const resumable = pos && pos.progress > 0.01 && !book.finished;
  const isRead = !!book.finished || !!(pos && pos.progress >= 0.98);
  const items = [
    { icon: resumable ? "play" : "headphones", title: resumable ? "Resume" : "Listen", desc: "Open the reader and start listening.", onClick: () => openBook(book) },
    isRead
      ? { icon: "readMarker", title: "Mark as read", desc: "Keep your place and mark it as read.", onClick: () => markRead(book) }
      : { icon: "unreadMarker", title: "Mark as unread", desc: "Return it to the start and mark it unread.", onClick: () => markUnread(book) },
    { icon: "folder", title: "Add to collection", desc: "File it in a collection, or start a new one.", onClick: () => openAddModal(book) },
    { icon: "share", title: "Share", desc: "Send a link to a friend, or publish it to Explore.", onClick: () => openShareModal(book) },
    { icon: "download", title: "Download as MP3", desc: "Synthesise the whole audiobook and save it as one MP3 file.", onClick: () => downloadBook(book) },
  ];
  if (local) {
    items.splice(3, 0, { icon: "image", title: "Cover art", desc: "Upload your own image, or let us paint one.", onClick: () => openCoverPicker(book) });
    items.push({ icon: book.archived ? "unarchive" : "archive", title: book.archived ? "Unarchive" : "Archive", desc: book.archived ? "Bring it back into your main library." : "Tuck it away without deleting it.", onClick: () => toggleArchive(book) });
    items.push({ icon: "trash", title: "Remove", desc: "Deletes it from this device. Published copies stay online.", danger: true, onClick: () => confirmRemove(book) });
  }
  body.appendChild(buildOpts(items));
  openModal({ title: "Options", body });
}

function pencilBtn(title, onClick) {
  const b = el("button", { class: "icon-btn pencil-btn", title, "aria-label": title, html: icon("pencil", { size: 15 }) });
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

async function toggleArchive(book) {
  book.archived = !book.archived;
  await store.patchBook(book.id, { archived: !!book.archived });
  if (app.currentBook && app.currentBook.id === book.id) app.currentBook.archived = book.archived;
  await loadLibrary();
  toast(book.archived ? "Archived — find it under “Archived”" : "Moved back to your library");
}

// "Add to collection" replaces the old "Move to…": it reads correctly from both
// Explore (where the book isn't in the library yet) and Library.
async function openAddModal(book) {
  const local = (app.library || []).find((b) => b.id === book.id) || null;
  const curId = local ? (local.collectionId ?? null) : null;
  const body = el("div");
  body.appendChild(el("p", { class: "hint", text: "Add “" + (book.title || "Untitled") + "” to a collection. Collections also play back like a queue." }));
  const list = el("div", { class: "opt-list move-list" });
  const rows = [{ id: null, depth: 0 }];
  const byParent = new Map();
  for (const c of app.collections || []) {
    const p = c.parentId ?? null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(c);
  }
  const walk = (parentId, depth) => {
    for (const c of byParent.get(parentId) || []) {
      rows.push({ id: c.id, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 1);
  for (const row of rows) {
    const isCurrent = curId === row.id;
    const o = el("div", { class: "move-row" + (isCurrent ? " current" : ""), style: { paddingLeft: (14 + row.depth * 20) + "px" } }, [
      el("span", { class: "move-ic", html: icon(row.id == null ? "library" : "folder", { size: 17 }) }),
      el("span", { class: "move-name", text: collectionName(row.id) }),
      isCurrent ? el("span", { class: "hint", text: "Current" }) : null,
    ]);
    if (!isCurrent) o.addEventListener("click", async () => { closeModal(); await addBookToCollection(book, row.id); });
    list.appendChild(o);
  }
  const newRow = el("div", { class: "move-row new" }, [
    el("span", { class: "move-ic", html: icon("folderPlus", { size: 17 }) }),
    el("span", { class: "move-name", text: "New collection…" }),
  ]);
  newRow.addEventListener("click", () => { closeModal(); newFolder(curId, book); });
  list.appendChild(newRow);
  body.appendChild(list);
  openModal({ title: "Add to collection", body });
}

// Put a book back at the start and clear its "finished" flag. Listening time is
// preserved — only the playhead resets.
async function markUnread(book) {
  const rec = await ensureLocalBook(book);
  if (!rec) return;
  const pos = app.positions[rec.id] || (await store.getPosition(rec.id)) || {};
  const next = { index: 0, offset: 0, progress: 0, listenSec: pos.listenSec || 0, updatedAt: Date.now() };
  await store.patchBook(rec.id, { finished: false });
  rec.finished = false;
  book.finished = false;
  await store.savePosition(rec.id, next);
  if (!app.positions) app.positions = {};
  app.positions[rec.id] = next;
  if (app.player.book && app.player.book.id === rec.id) { app.player.seekToIndex(0, 0); persistPosition(); }
  await loadLibrary();
  toast("Marked as unread");
}

// Mark a book as read without touching the playhead (unlike markUnread, which
// rewinds to the start).
async function markRead(book) {
  const rec = await ensureLocalBook(book);
  if (!rec) return;
  await store.patchBook(rec.id, { finished: true });
  rec.finished = true;
  book.finished = true;
  const lib = (app.library || []).find((b) => b.id === rec.id);
  if (lib) lib.finished = true;
  if (app.currentBook && app.currentBook.id === rec.id) app.currentBook.finished = true;
  if (app.player.book && app.player.book.id === rec.id) app.player.book.finished = true;
  await loadLibrary();
  toast("Marked as read");
}

// A per-book narrator. Choosing "Default" stores null so the book follows the
// global setting again.
function openVoicePicker(book, { onClose } = {}) {
  const body = el("div");
  body.appendChild(el("p", { class: "hint", text: "Pick the narrator for “" + (book.title || "Untitled") + "”. “Default” follows your global setting." }));
  const list = el("div", { class: "voice-list" });
  const cur = book.voice || "";
  const rows = [{ id: "", name: "Default", meta: "Uses “" + voiceLabel(app.settings.voice) + "”", lang: "" }]
    .concat(ALL_VOICES.map((v) => ({ id: v.id, name: v.name, meta: v.gender + (LIGHT_VOICE_IDS.includes(v.id) ? " · Light" : ""), lang: v.lang === "en-gb" ? "UK" : "US" })));
  for (const r of rows) {
    const row = el("div", { class: "voice-row" + (r.id === cur ? " active" : "") });
    row.appendChild(el("div", { class: "voice-name" }, [
      el("b", { text: r.name }),
      el("span", { class: "hint", text: [r.meta, r.lang].filter(Boolean).join(" · ") }),
    ]));
    const prev = el("button", { class: "icon-btn", title: "Preview", "aria-label": "Preview narrator", html: icon("play", { size: 16 }) });
    prev.addEventListener("click", (e) => { e.stopPropagation(); previewVoice(r.id || app.settings.voice, prev); });
    row.appendChild(prev);
    row.addEventListener("click", async () => {
      const rec = await ensureLocalBook(book);
      if (!rec) { closeModal(); return; }
      rec.voice = r.id || null;
      await store.patchBook(rec.id, { voice: rec.voice });
      book.voice = rec.voice;
      if (app.currentBook && app.currentBook.id === rec.id) app.currentBook.voice = rec.voice;
      if (app.player.book && app.player.book.id === rec.id) {
        app.player.book.voice = rec.voice;
        app.player.setVoice(bookVoice(rec));
        app.failedChunks.clear();
      }
      closeModal();
      toast(r.id ? "Narrator: " + r.name : "Using your default narrator");
    });
    list.appendChild(row);
  }
  body.appendChild(list);
  openModal({ title: "Narrator", body, onClose });
}

// Right-click (desktop) and long-press (touch) popup. It exposes the common
// actions inline; "More options" opens the full modal for tags and the rest.
function bookContextMenu(book, { x = 0, y = 0 } = {}) {
  const local = (app.library || []).find((b) => b.id === book.id) || null;
  const pos = app.positions[book.id] || (local && app.positions[local.id]);
  const resumable = pos && pos.progress > 0.01 && !book.finished;
  const isRead = !!book.finished || !!(pos && pos.progress >= 0.98);
  const items = [];
  items.push({ icon: resumable ? "play" : "headphones", label: resumable ? "Resume" : "Listen", onClick: () => openBook(book) });
  items.push(isRead
    ? { icon: "readMarker", label: "Mark as read", onClick: () => markRead(book) }
    : { icon: "unreadMarker", label: "Mark as unread", onClick: () => markUnread(book) });
  items.push({ icon: "folder", label: "Add to collection…", onClick: () => openAddModal(book) });
  items.push({ icon: "sliders", label: "Narrator…", onClick: () => openVoicePicker(book) });
  if (local && (local.collectionId ?? null) != null) {
    items.push({ icon: "up", label: "Move up", onClick: () => reorderBook(local, -1) });
    items.push({ icon: "down", label: "Move down", onClick: () => reorderBook(local, 1) });
  }
  items.push({ separator: true });
  items.push({ icon: "share", label: "Share…", onClick: () => openShareModal(book) });
  if (local) {
    items.push({ icon: local.archived ? "unarchive" : "archive", label: local.archived ? "Unarchive" : "Archive", onClick: () => toggleArchive(local) });
    items.push({ icon: "edit", label: "Rename…", onClick: () => renameBook(local) });
    items.push({ icon: "trash", label: "Remove from library", danger: true, onClick: () => confirmRemove(local) });
  }
  items.push({ separator: true });
  items.push({ icon: "list", label: "More options…", onClick: () => openBookMenu(book) });
  openContextMenu(items, { x, y });
}

function renameBook(book) {
  const body = el("div");
  const title = el("input", { class: "input", value: book.title || "", maxlength: "100", placeholder: "Title" });
  const author = el("input", { class: "input", value: book.author || "", maxlength: "40", placeholder: "Author (optional)" });
  body.append(el("div", { class: "field" }, [el("label", { text: "Title" }), title]));
  body.append(el("div", { class: "field", style: { marginTop: "12px" } }, [el("label", { text: "Author" }), author]));
  openModal({
    title: "Title & author", body,
    actions: [
      { label: "Cancel", class: "btn-ghost", onClick: closeModal },
      { label: "Save", class: "btn-primary", onClick: async () => {
        const newTitle = title.value.trim();
        const patch = { author: author.value.trim() };
        if (newTitle && newTitle !== book.title) { patch.title = newTitle; patch.titleSource = "user"; }
        Object.assign(book, patch);
        await store.patchBook(book.id, patch);
        closeModal();
        loadLibrary();
        if (app.currentBook && app.currentBook.id === book.id) {
          app.currentBook.title = book.title;
          app.currentBook.author = book.author;
          updatePlayerHeader(app.currentBook);
        }
        toast("Saved");
      } },
    ],
  });
  setTimeout(() => { title.focus(); title.select(); }, 80);
}

// Keep every copy of a book's cover state in step after the cover changes:
// the library item, the currently-open book, the player, and its media session.
function applyCoverToBook(book, { coverLocal, coverUrl }) {
  book.coverLocal = coverLocal;
  book.coverUrl = coverUrl;
  if (app.currentBook && app.currentBook.id === book.id) {
    app.currentBook.coverLocal = coverLocal;
    app.currentBook.coverUrl = coverUrl;
  }
  const pb = app.player && app.player.book;
  if (pb && pb.id === book.id) {
    pb.coverLocal = coverLocal;
    pb.coverUrl = coverUrl;
    try { app.player.setupMediaSession(); } catch (e) {}
  }
  const mp = $("#miniPlayer");
  if (mp && mp._cov && pb && pb.id === book.id) paintCover(mp._cov, pb);
}

// Change a local book's cover art: upload your own image, paint one with the
// text-to-image plugin, re-crop, or remove it. A new image is cropped to the
// shape of the card slot and kept ON THIS DEVICE — it is only uploaded if the
// book is later shared (a share link, or a publish to Explore).
function openCoverPicker(book) {
  const body = el("div");
  const row = el("div", { class: "cover-pick" });
  const prev = el("div", { class: "cover-pick-art" });
  const side = el("div", { class: "cover-pick-side" });
  row.append(prev, side);
  body.appendChild(row);

  let pending = null;      // cropped blob the user hasn't saved yet
  let pendingUrl = null;   // its object URL
  let saveBusy = false;
  const savedUrl = () => covers.coverUrlFor(book);

  const paint = () => {
    prev.innerHTML = "";
    prev.style.background = "";
    const src = pending ? pendingUrl : savedUrl();
    if (src) {
      const img = el("img", { src, alt: "" });
      img.addEventListener("error", () => { img.remove(); paintProceduralCover(prev, book); }, { once: true });
      prev.appendChild(img);
    } else {
      paintProceduralCover(prev, book);
    }
  };

  const setPending = (blob) => {
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pending = blob;
    pendingUrl = blob ? URL.createObjectURL(blob) : null;
    render();
  };

  const chipBtn = (label, ic, fn, cls) =>
    el("button", { class: "chip" + (cls ? " " + cls : ""), onclick: fn }, [icon(ic, { size: 15 }), label]);

  const fileInput = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
  const uploadBtn = chipBtn("Choose image", "image", () => fileInput.click());
  // PORT: cover generation needs the Perchance backend; the button stays as a
  // disabled placeholder so upload-crop and remove keep their layout.
  const genBtn = el("button", { class: "chip", disabled: true, title: "Cover generation needs the Perchance backend — unavailable in this standalone build" }, [icon("sparkle", { size: 15 }), "Paint one"]);
  const adjustBtn = chipBtn("Adjust crop", "sliders", () => startCrop(pending));
  const removeBtn = chipBtn("Remove", "trash", removeCover, "ghost");
  const btns = el("div", { class: "chips" }, [uploadBtn, genBtn, adjustBtn, removeBtn, fileInput]);

  const saveBtn = el("button", { class: "btn btn-primary btn-block", style: { marginTop: "16px" }, disabled: true }, ["Save cover"]);
  saveBtn.addEventListener("click", save);
  body.appendChild(saveBtn);

  const render = () => {
    paint();
    side.innerHTML = "";
    side.appendChild(el("b", { text: "Cover art" }));
    side.appendChild(el("div", { class: "hint", text: "Cropped to the card's wide shape, and kept on this device until you share." }));
    side.appendChild(btns);
    adjustBtn.hidden = !(pending || (book.coverLocal && !book.coverUrl));
    removeBtn.hidden = !(pending || savedUrl());
    saveBtn.disabled = saveBusy || !pending;
  };

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast("Choose an image file", { type: "error" }); return; }
    if (f.size > 12 * 1024 * 1024) { toast("Image too large (12 MB max)", { type: "error" }); return; }
    startCrop(f);
  });

  // Crop `source` (or the pending / stored image when omitted) to the card shape.
  async function startCrop(source) {
    let blob = source || pending;
    if (!blob && book.coverLocal && !book.coverUrl) blob = await store.getCover(book.id);
    if (!blob) { fileInput.click(); return; }
    const cropped = await openCropper(blob, { aspect: COVER_ASPECT, title: "Crop cover" });
    if (cropped) setPending(cropped);
  }

  async function generate() {
    genBtn.disabled = true;
    genBtn.innerHTML = "";
    genBtn.appendChild(spinnerNode(14));
    genBtn.appendChild(document.createTextNode(" Painting…"));
    try {
      const { blob } = await share.generateCover({ title: book.title || "", tags: book.tags || [] });
      const cropped = await openCropper(blob, { aspect: COVER_ASPECT, title: "Crop cover" });
      if (cropped) setPending(cropped);
    } catch (e) {
      toast("Cover generation failed", { type: "error" });
    } finally {
      genBtn.disabled = false;
      genBtn.innerHTML = "";
      genBtn.insertAdjacentHTML("beforeend", icon("sparkle", { size: 15 }));
      genBtn.appendChild(document.createTextNode(" Paint one"));
      render();
    }
  }

  async function removeCover() {
    setPending(null);
    await store.deleteCover(book.id);
    covers.forget(book.id);
    await store.patchBook(book.id, { coverLocal: false, coverUrl: "" });
    applyCoverToBook(book, { coverLocal: false, coverUrl: "" });
    await loadLibrary();
    render();
    toast("Cover removed");
  }

  async function save() {
    if (!pending) return;
    saveBusy = true;
    saveBtn.disabled = true;
    saveBtn.innerHTML = "";
    saveBtn.appendChild(spinnerNode(15));
    saveBtn.appendChild(document.createTextNode(" Saving…"));
    try {
      const blob = pending;
      await store.putCover(book.id, blob);
      covers.set(book.id, blob);
      await store.patchBook(book.id, { coverLocal: true, coverUrl: "" });
      applyCoverToBook(book, { coverLocal: true, coverUrl: "" });
      if (pendingUrl) { URL.revokeObjectURL(pendingUrl); }
      pending = null;
      pendingUrl = null;
      await loadLibrary();
      closeModal();
      toast("Cover updated");
    } catch (e) {
      console.warn(e);
      toast("Couldn't save the cover", { type: "error" });
      saveBusy = false;
      saveBtn.disabled = false;
      saveBtn.innerHTML = "Save cover";
    }
  }

  render();
  openModal({ title: "Cover art", body, onClose: () => { if (pendingUrl) URL.revokeObjectURL(pendingUrl); } });
}

function confirmRemove(book) {
  openModal({
    title: "Remove audiobook?", body: "“" + (book.title || "Untitled") + "” will be deleted from this device. This cannot be undone.",
    actions: [
      { label: "Keep", class: "btn-ghost", onClick: closeModal },
      { label: "Remove", class: "btn-danger", onClick: async () => {
        closeModal();
        if (app.currentBook && app.currentBook.id === book.id) {
          app.player.close();
          app.currentBook = null;
          closePlayerScreen();
        }
        await store.removeBook(book.id);
        covers.forget(book.id);
        app.bookmarks = await store.listBookmarks();
        if (app.bmQueue) app.bmQueue.ids = app.bmQueue.ids.filter((id) => findBookmark(id));
        if (app.bookQueue) app.bookQueue.ids = app.bookQueue.ids.filter((id) => id !== book.id);
        paintQueueBar();
        await loadLibrary();
        toast("Removed");
      } },
    ],
  });
}

// ===========================================================================
// Library backup / restore
// ===========================================================================
function openBackupModal() {
  const body = el("div");

  // --- local folder sync: the strongest backup the app can offer -------------
  // Hidden entirely when the picker can't be shown here (e.g. Perchance's
  // cross-origin iframe) so users don't read a policy restriction as their fault.
  if (fssync.isAvailable()) {
    const sync = el("div", { class: "sync-box" });
    sync.appendChild(el("div", { class: "sync-head" }, [
      el("span", { class: "sync-ic", html: icon("folder", { size: 18 }) }),
      el("b", { text: "Sync with a local folder" }),
    ]));
    sync.appendChild(el("p", { class: "hint", text: "Mirror your entire library into a folder on this device. It writes a real backup file you keep forever — the most durable backup there is." }));
    const status = el("div", { class: "hint sync-status" });
    const row = el("div", { class: "chips", style: { marginTop: "10px" } });
    sync.append(status, row);
    body.appendChild(sync);

    const paint = async () => {
      row.innerHTML = "";
      status.textContent = "";
      let info = null;
      try { info = await fssync.describe(); } catch (e) {}
      if (!info) {
        const pick = el("button", { class: "btn btn-primary" }, [icon("folderPlus", { size: 17 }), "Sync with local folder"]);
        pick.addEventListener("click", () => doPick(pick));
        row.appendChild(pick);
        status.textContent = "No folder chosen yet.";
      } else {
        const now = el("button", { class: "btn btn-primary" }, [icon("download", { size: 17 }), "Sync now"]);
        now.addEventListener("click", () => doSync(now));
        const change = el("button", { class: "btn btn-ghost", onclick: () => doPick(change) }, ["Change folder…"]);
        const off = el("button", { class: "btn btn-ghost", onclick: async () => { await fssync.forgetHandle(); await store.setSetting("syncFolderName", ""); toast("Stopped syncing"); paint(); } }, ["Disconnect"]);
        row.append(now, change, off);
        const bits = ["Folder: " + info.name];
        if (!info.granted) bits.push("permission needed — tap Sync now");
        if (app.settings.lastSyncAt) bits.push("last synced " + new Date(app.settings.lastSyncAt).toLocaleString());
        status.textContent = bits.join(" · ");
      }
    };
    const doPick = async (btn) => {
      const old = btn ? btn.innerHTML : null;
      if (btn) { btn.disabled = true; btn.innerHTML = ""; btn.appendChild(spinnerNode(16)); btn.appendChild(document.createTextNode(" Choosing…")); }
      try {
        const h = await fssync.chooseFolder();
        await store.setSetting("syncFolderName", h.name || "");
        if (btn) { btn.disabled = false; btn.innerHTML = old; }
        await doSync(null);
      } catch (e) {
        if (btn) { btn.disabled = false; btn.innerHTML = old; }
        if (e && e.name === "AbortError") return;
        toast("Couldn't use that folder" + (e && e.message ? " — " + e.message : ""), { type: "error" });
        paint();
      }
    };
    const doSync = async (btn) => {
      const old = btn ? btn.innerHTML : null;
      if (btn) { btn.disabled = true; btn.innerHTML = ""; btn.appendChild(spinnerNode(16)); btn.appendChild(document.createTextNode(" Syncing…")); }
      try {
        const res = await fssync.syncNow({ includeArchived: true, force: true });
        app.settings.lastSyncAt = res.at;
        await store.setSetting("lastSyncAt", res.at);
        toast("Synced " + res.bookCount + (res.bookCount === 1 ? " audiobook" : " audiobooks") + " · " + fmtBytes(res.bytes), { timeout: 4200 });
      } catch (e) {
        if (e && e.message === "permission") toast("Write permission was denied for that folder", { type: "error" });
        else toast("Sync failed" + (e && e.message ? " — " + e.message : ""), { type: "error" });
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = old; }
        paint();
      }
    };
    paint();
    body.appendChild(el("div", { class: "divider" }));
  }

  body.appendChild(el("p", { class: "hint", text: "Export everything on this device — the text, titles, tags, folders and playback positions of your library — as a single .zip file. Audio is regenerated on demand, so the bundle stays small." }));

  const includeRow = el("label", { class: "check-row" });
  const check = el("input", { type: "checkbox" });
  includeRow.append(check, el("span", { text: "Include archived audiobooks" }));
  body.appendChild(includeRow);

  const estimate = el("div", { class: "hint", style: { marginTop: "10px" }, text: "Estimating…" });
  body.appendChild(estimate);

  const exportBtn = el("button", { class: "btn btn-primary btn-block", style: { marginTop: "16px" }, disabled: true }, [icon("download", { size: 17 }), "Export library"]);
  body.appendChild(exportBtn);

  body.appendChild(el("div", { class: "divider" }));

  const importBtn = el("button", { class: "btn btn-ghost btn-block" }, [icon("upload", { size: 17 }), "Import from a backup file"]);
  importBtn.addEventListener("click", () => { closeModal(); pickImportFile(); });
  body.appendChild(importBtn);
  body.appendChild(el("div", { class: "hint", style: { marginTop: "8px", textAlign: "center" }, text: "Importing adds books that aren't already here; nothing is overwritten." }));

  let prepared = null;
  const refresh = async () => {
    estimate.textContent = "Estimating…";
    exportBtn.disabled = true;
    try {
      prepared = await backup.prepare({ includeArchived: check.checked });
      estimate.textContent = prepared.bookCount
        ? prepared.bookCount + (prepared.bookCount === 1 ? " audiobook" : " audiobooks") +
          (prepared.folderCount ? " · " + prepared.folderCount + (prepared.folderCount === 1 ? " folder" : " folders") : "") +
          " · about " + fmtBytes(prepared.bytes)
        : "Nothing to export yet.";
      exportBtn.disabled = prepared.bookCount === 0;
    } catch (e) {
      estimate.textContent = "Couldn't read your library.";
    }
  };
  check.addEventListener("change", refresh);
  exportBtn.addEventListener("click", async () => {
    if (!prepared) return;
    exportBtn.disabled = true;
    exportBtn.innerHTML = "";
    exportBtn.appendChild(spinnerNode(16));
    exportBtn.appendChild(document.createTextNode(" Packing…"));
    try {
      const { blob } = await backup.zipFromData(prepared.data, (p) => {
        exportBtn.lastChild.textContent = " Packing… " + Math.round(p * 100) + "%";
      });
      closeModal();
      downloadBlob(blob, "audionook-library-" + new Date().toISOString().slice(0, 10) + ".zip");
      toast("Backup saved · " + fmtBytes(blob.size));
    } catch (e) {
      exportBtn.disabled = false;
      exportBtn.innerHTML = "";
      exportBtn.insertAdjacentHTML("beforeend", icon("download", { size: 17 }));
      exportBtn.appendChild(document.createTextNode(" Export library"));
      toast("Export failed", { type: "error" });
    }
  });

  openModal({ title: "Backup & export", body });
  refresh();
}

function pickImportFile() {
  const input = el("input", { type: "file", accept: ".zip,application/zip", style: { display: "none" } });
  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    input.remove();
    if (f) importBackupFile(f);
  });
  document.body.appendChild(input);
  input.click();
}

async function importBackupFile(file) {
  const body = el("div");
  const detail = el("div", { class: "hint", text: "Reading " + file.name + "…" });
  body.appendChild(detail);
  const bar = el("div", { class: "pub-bar" }, [el("i")]);
  body.appendChild(bar);
  openModal({ title: "Importing library", body });
  try {
    const res = await backup.restoreBundle(file);
    closeModal();
    await Promise.all([loadLibrary(), loadCollections()]);
    const bits = [];
    bits.push(res.imported + (res.imported === 1 ? " audiobook" : " audiobooks") + " added");
    if (res.folders) bits.push(res.folders + (res.folders === 1 ? " folder" : " folders"));
    if (res.skipped) bits.push(res.skipped + " already here");
    toast("Import complete — " + bits.join(" · "), { timeout: 5000 });
  } catch (e) {
    closeModal();
    toast("Couldn't import that file" + (e && e.message ? " — " + e.message : ""), { type: "error", timeout: 6000 });
  }
}

// ===========================================================================
// Explore
// ===========================================================================
async function loadExplore({ reset = false } = {}) {
  const st = app.explore;
  if (st.loading) return;
  if (reset) { st.offset = 0; st.items = []; st.total = 0; }
  st.loading = true;
  st.error = false;
  if (app.route === "explore") renderExplore(app);
  try {
    const res = await app.net.list({
      sort: st.sort, offset: st.offset, limit: PAGE_SIZE, tagBits: st.tagBits,
      query: st.query,
    });
    st.total = res.total;
    st.listenSec = res.listenSec;
    const seen = new Set(reset ? [] : st.items.map((i) => i.id));
    const incoming = res.items.filter((i) => !seen.has(i.id));
    st.items = reset ? incoming : st.items.concat(incoming);
    st.offset = st.items.length;
  } catch (e) {
    st.error = true;
    if (reset && app.route === "explore") renderExplore(app);
  } finally {
    st.loading = false;
    if (app.route === "explore") renderExplore(app);
    hydrateExplore();
    if (reset) refreshStats();
  }
}

// Listing rows carry only the compact server metadata; the display/playback
// fields (blurb, text, cover, voice) live in a tiny uploaded bundle. Fetch them
// a few at a time and swap each card in as it arrives.
async function hydrateExplore() {
  const st = app.explore;
  const pending = st.items.filter((it) => !it._hydrated && !it._hydrating);
  if (!pending.length) return;
  for (const it of pending) it._hydrating = true;
  st.hydrating = (st.hydrating || 0) + pending.length;
  let cursor = 0;
  const runOne = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      try {
        const bundle = await share.fetchBundle(item.bundleId);
        if (bundle) share.applyBundle(item, bundle);
        else item._bundleMissing = true;
      } catch (e) {
        item._bundleMissing = true;
      }
      item._hydrated = true;
      item._hydrating = false;
      if (app.route === "explore") refreshExploreCard(app, item);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(6, pending.length); i++) workers.push(runOne());
  await Promise.all(workers);
  st.hydrating = Math.max(0, (st.hydrating || 0) - pending.length);
  const stillPending = st.items.some((it) => !it._hydrated && !it._hydrating);
  if (st.hydrating === 0 && !stillPending) verifyExploreItems();
}

async function refreshStats() {
  try {
    const s = await app.net.stats();
    app.explore.stats = s;
    app.explore.statsAt = Date.now();
    if (app.route === "explore") renderExplore(app);
  } catch (e) {}
}

// Resolve a hosted file's real NSFW tag from the host (uploader API), caching
// the answer. Throws when the host can't be reached so callers can retry later.
async function nsfwForUrl(url) {
  if (!url) return false;
  const known = await store.getNsfw(url);
  if (known != null) return known;
  const flag = await share.checkNsfw(url);
  if (flag == null) throw new Error("nsfw-check-unavailable");
  await store.setNsfw(url, flag);
  return flag;
}

// View-time NSFW verification. The declared rating is gone entirely from the
// submission (a tampered client could send anything), so the truth is read here
// from the host's own file tags — for BOTH the text and the cover — every time a
// visitor loads Explore. Results are cached per-URL so this costs one call per
// file, ever. When the content filter is on, offending rows are dropped.
async function verifyExploreItems() {
  const st = app.explore;
  if (st.verifying) return;
  const pending = st.items.filter((it) => it._checked !== true);
  if (!pending.length) return;
  st.verifying = pending.length;
  if (app.route === "explore") renderExplore(app);
  const workers = [];
  let cursor = 0;
  const runOne = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      try {
        if (!item.textUrl && !item.coverUrl) { item._checked = true; continue; }
        const textNsfw = await nsfwForUrl(item.textUrl);
        const coverNsfw = item.coverUrl ? await nsfwForUrl(item.coverUrl) : false;
        item._checked = true;
        if (textNsfw || coverNsfw) { item._nsfw = true; item.nsfw = true; }
      } catch (e) { item._checked = false; }
    }
  };
  for (let i = 0; i < Math.min(4, pending.length); i++) workers.push(runOne());
  await Promise.all(workers);
  const before = st.items.length;
  if (app.settings.safeMode) st.items = st.items.filter((it) => !it._nsfw);
  st.total = Math.max(0, st.total - (before - st.items.length));
  st.verifying = 0;
  if (app.route === "explore") renderExplore(app);
  const removed = before - st.items.length;
  // The filter count is reported when the user actually visits Explore, never
  // as a stray toast over the Library/Create tabs the background verification
  // ran under.
  st.hiddenByFilter = (st.hiddenByFilter || 0) + removed;
  flushFilterNotice();
}

// Toast the accumulated content-filter count, but only while Explore is the
// visible tab. Anything banked while the user is elsewhere waits until they
// visit.
function flushFilterNotice() {
  const st = app.explore;
  if (app.route !== "explore" || !st.hiddenByFilter) return;
  const n = st.hiddenByFilter;
  st.hiddenByFilter = 0;
  toast(n + (n === 1 ? " audiobook was" : " audiobooks were") + " hidden by your content filter", { type: "info" });
}

function onNewBook(book) {
  const st = app.explore;
  if (book && !st.items.some((i) => i.id === book.id)) {
    if (st.sort !== "trending") {
      if (st.sort === "top") st.items.push(book);
      else st.items.unshift(book);
      st.total += 1;
      if (app.route === "explore") renderExplore(app);
    }
    toast("Just published: " + truncate(book.title, 40));
    hydrateExplore();
  }
}

// ===========================================================================
// Create
// ===========================================================================
function countChunks(text) {
  if (!text || text.trim().length < 3) return 0;
  try { return splitTextIntoChunks(text).length; } catch (e) { return 0; }
}

async function createBook() {
  const c = app.create;
  const text = (c.text || "").trim();
  if (text.length < 3) { toast("Paste or type some text first", { type: "error" }); return; }
  const words = wordCount(text);
  // A narrator explicitly chosen in the Create pane is stored on the book; if it
  // matches the global default we store null so the book keeps following it.
  const voice = c.voice && c.voice !== app.settings.voice ? c.voice : null;
  const collectionId = app.libraryView.collectionId ?? null;
  const book = {
    id: uid(),
    title: truncate(autoTitle(text), 100),
    titleSource: "auto",
    author: "",
    blurb: "",
    text,
    voice,
    wordCount: words,
    createdAt: Date.now(),
    origin: "local",
    tags: [],
    collectionId,
    order: nextOrder(collectionId),
    archived: false,
  };
  await store.putBook(book);
  c.text = "";
  flushCreateDraft();
  await loadLibrary();
  openBook(book, { autoplay: true });
  deduceTitle(book, text);
}

// The title is inferred from the text in the background: the first suitable
// line stands in immediately so the library and reader are never blank, then
// the AI's title replaces it unless the user has renamed the book by then.
async function deduceTitle(book, text) {
  app.titling.add(book.id);
  if (app.currentBook && app.currentBook.id === book.id) updatePlayerHeader(app.currentBook);
  try {
    const title = await share.generateTitle(text);
    if (!title) return;
    const fresh = await store.getBook(book.id);
    if (!fresh || fresh.titleSource !== "auto") return;
    await store.patchBook(book.id, { title: truncate(title, 100) });
    if (app.currentBook && app.currentBook.id === book.id) {
      app.currentBook.title = title;
    }
    await loadLibrary();
  } catch (e) {
    // Title inference is a nicety — the provisional title is perfectly usable.
  } finally {
    app.titling.delete(book.id);
    if (app.currentBook && app.currentBook.id === book.id) updatePlayerHeader(app.currentBook);
  }
}

function autoTitle(text) {
  const first = text.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length > 1 && l.length <= 80);
  return first || "Untitled";
}

// A book plays with its own narrator when it has one, otherwise the global
// default. `book.voice == null` means "follow the default".
function bookVoice(book) {
  return (book && book.voice) || app.settings.voice;
}

// ===========================================================================
// Opening a book
// ===========================================================================
async function openBook(b, { autoplay = false, position = null } = {}) {
  if (!b || !b.id) return;
  await share.ensureBundle(b);
  // Already loaded? Just bring the reader forward — don't reopen and reset it.
  if (app.player.book && app.player.book.id === b.id && app.player.total) {
    app.currentBook = app.player.book;
    openPlayerScreen();
    if (position && typeof position.index === "number") app.player.seekToIndex(position.index, position.offset || 0);
    if (autoplay && !app.player.isPlaying) { app.player.play(); reportPlay(app.player.book); }
    return;
  }
  const stored = await store.getBook(b.id);
  const book = Object.assign({}, stored || {}, b);
  book.id = b.id;
  app.currentBook = book;
  app.failedChunks.clear();
  if (!app._queueOpening && app.bmQueue) exitBookmarkQueue();
  if (!app._bookQueueOpening && app.bookQueue && !(app.bookQueue.ids || []).includes(book.id)) exitBookQueue();
  hideBookmarkPop();

  // Show the player immediately — the cover and title are already known.
  updatePlayerHeader(book);
  renderReaderLoading(book);
  openPlayerScreen();

  let text = book.text || (await store.getText(book.id));
  if (!text && book.textUrl) {
    try {
      text = await share.fetchText(book.textUrl);
    } catch (e) {
      toast("Couldn't fetch this audiobook's text", { type: "error" });
      closePlayerScreen();
      return;
    }
  }
  if (!text) { toast("This audiobook has no text", { type: "error" }); closePlayerScreen(); return; }

  book.text = text;
  book.wordCount = book.wordCount || wordCount(text);
  book.createdAt = book.createdAt || Date.now();
  book.chunks = splitTextIntoChunks(text);
  await store.putBook(book);

  // NOTE: deliberately do NOT ensureEngine() here. Opening a book must not spin
  // up the worker pool on its own — the engine's warm pass resolves whatever is
  // already cached (drawing any peers), and only a genuine cache miss near the
  // playhead calls back through onNeedEngine(). A fully-narrated book therefore
  // opens and plays with zero workers.
  const pos = position || (await store.getPosition(book.id));
  app.player.rate = app.settings.rate || 1;
  app.player.open(book, book.chunks, { position: pos, voice: bookVoice(book) });
  app.player.setupMediaSession();
  renderReader(book);
  updatePlayerHeader(book);
  updatePlayerUI(app.player.getState());

  const resume = pos && pos.progress > 0.01 && pos.progress < 0.985;
  if (autoplay || resume) { app.player.play(); reportPlay(book); }
  loadLibrary();
}

// ===========================================================================
// Share
// ===========================================================================
async function ensureTextUrl(book) {
  if (book.textUrl) return book.textUrl;
  const text = book.text || (await store.getText(book.id));
  if (!text) throw new Error("no text");
  const res = await share.uploadText(text);
  book.textUrl = res.url;
  await store.patchBook(book.id, { textUrl: res.url });
  return res.url;
}

// Cover art stays local until the book is actually shared. This uploads it (and
// records the resulting URL on the book) the first time a share needs it.
async function ensureCoverUrl(book) {
  if (book.coverUrl) return book.coverUrl;
  if (!book.coverLocal) return "";
  const blob = await store.getCover(book.id);
  if (!blob) return "";
  const up = await share.uploadBlob(blob);
  book.coverUrl = up.url;
  await store.patchBook(book.id, { coverUrl: up.url });
  if (app.currentBook && app.currentBook.id === book.id) app.currentBook.coverUrl = up.url;
  return up.url;
}

async function openShareModal(book) {
  if (!book) return;
  await share.ensureBundle(book);
  const body = el("div");
  const hero = el("div", { class: "share-hero" });
  hero.appendChild(coverNode(book));
  const info = el("div");
  info.appendChild(el("b", { text: book.title || "Untitled" }));
  info.appendChild(el("div", { class: "hint", text: book.author || "Unknown author" }));
  const wc = book.wordCount || (book.text ? wordCount(book.text) : 0);
  if (wc) info.appendChild(el("div", { class: "hint", text: formatCompact(wc) + " words" }));
  hero.appendChild(info);
  body.appendChild(hero);

  const linkRow = el("div", { class: "share-link-row" });
  const linkInput = el("input", { class: "input", readonly: true, placeholder: "Creating your link…" });
  const copyBtn = el("button", { class: "btn btn-primary" }, [icon("share", { size: 16 }), "Copy"]);
  const setCopyBtn = (iconName, label) => {
    copyBtn.innerHTML = "";
    if (iconName) copyBtn.insertAdjacentHTML("beforeend", icon(iconName, { size: 16 }));
    else copyBtn.appendChild(spinnerNode(16));
    copyBtn.appendChild(document.createTextNode(" " + label));
  };
  linkRow.append(linkInput, copyBtn);
  body.appendChild(linkRow);
  body.appendChild(el("p", { class: "hint", text: "Anyone with this link can listen." }));

  const opts = el("div", { class: "opt-list" });

  const pubOpt = el("div", { class: "opt opt-wide" });
  pubOpt.appendChild(el("div", { class: "opt-ic", html: icon("globe", { size: 18 }) }));
  const pubText = el("div");
  pubText.appendChild(el("b", { text: book.seq != null ? "Published to Explore" : "Publish to Explore" }));
  pubOpt.appendChild(pubText);
  pubOpt.addEventListener("click", () => {
    if (book.seq != null) { closeModal(); navigate("explore"); return; }
    // Publishing is permanent (a published copy stays online), so make the user
    // acknowledge it before the catalogue form even opens.
    openModal({
      title: "Publish to Explore?",
      body: "This will permanently share this audiobook to the public library, where anyone can find and listen to it. Continue?",
      actions: [
        { label: "Cancel", class: "btn-ghost", onClick: closeModal },
        { label: "Continue", class: "btn-primary", onClick: () => { closeModal(); openPublishModal(book); } },
      ],
    });
  });
  opts.appendChild(pubOpt);

  body.appendChild(opts);

  const modal = openModal({ title: "Share", body });
  let linkReady = false;
  const publish = async () => {
    copyBtn.disabled = true;
    setCopyBtn(null, "Creating…");
    linkInput.value = "Creating your link…";
    try {
      await ensureTextUrl(book);
      await ensureCoverUrl(book);
      const { id } = await share.publishShareMeta(book);
      const url = share.shareUrlFor(id);
      linkInput.value = url;
      linkReady = true;
      copyBtn.disabled = false;
      setCopyBtn("check", "Copied");
      setTimeout(() => { try { setCopyBtn("share", "Copy"); } catch (e) {} }, 1800);
      await copyText(url);
      toast("Link copied — send it to a friend");
    } catch (e) {
      copyBtn.disabled = false;
      setCopyBtn("share", "Copy");
      linkInput.value = "";
      linkInput.placeholder = "Upload failed — tap Copy to retry";
      toast("Couldn't create the link (" + (e.message || "error") + ")", { type: "error" });
    }
  };
  copyBtn.addEventListener("click", () => {
    if (linkReady && linkInput.value) { copyText(linkInput.value); toast("Link copied"); return; }
    publish();
  });
  setTimeout(publish, 150);
}

// ===========================================================================
// Publish (upload text -> AI catalogue -> cover -> server listing)
// ===========================================================================
async function openPublishModal(book) {
  const body = el("div");

  const coverRow = el("div", { class: "cover-pick" });
  const coverPrev = el("div", { class: "cover-pick-art" });
  const coverBtns = el("div", { class: "chips" });
  coverRow.append(coverPrev, el("div", { class: "cover-pick-side" }, [
    el("b", { text: "Cover art" }),
    el("div", { class: "hint", text: "Cropped to the listing's wide shape. Upload your own, or let us generate one." }),
    coverBtns,
  ]));
  body.appendChild(coverRow);

  let coverState = { blob: null, url: covers.coverUrlFor(book) || null };
  let coverPreviewUrl = null;
  const paintCoverPreview = () => {
    coverPrev.innerHTML = "";
    coverPrev.style.background = "";
    const src = coverPreviewUrl || coverState.url;
    if (src) {
      const img = el("img", { src, alt: "" });
      img.addEventListener("error", () => { img.remove(); paintProceduralCover(coverPrev, book); }, { once: true });
      coverPrev.appendChild(img);
    } else {
      paintProceduralCover(coverPrev, book);
    }
  };
  paintCoverPreview();

  const setCover = (blob) => {
    if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    coverState.blob = blob;
    coverPreviewUrl = blob ? URL.createObjectURL(blob) : null;
    paintCoverPreview();
  };

  const fileInput = el("input", { type: "file", accept: "image/*", style: { display: "none" } });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast("Choose an image file", { type: "error" }); return; }
    if (f.size > 12 * 1024 * 1024) { toast("Image too large (12 MB max)", { type: "error" }); return; }
    const cropped = await openCropper(f, { aspect: COVER_ASPECT, title: "Crop cover" });
    if (cropped) setCover(cropped);
  });
  const uploadBtn = el("button", { class: "chip" }, [icon("image", { size: 15 }), "Upload"]);
  uploadBtn.addEventListener("click", () => fileInput.click());
  // PORT: cover generation needs the Perchance backend; the button stays as a
  // disabled placeholder so the upload-crop option keeps its layout.
  const genBtn = el("button", { class: "chip", disabled: true, title: "Cover generation needs the Perchance backend — unavailable in this standalone build" }, [icon("sparkle", { size: 15 }), "Generate"]);
  coverBtns.append(uploadBtn, genBtn, fileInput);
  body.appendChild(el("div", { class: "divider" }));

  // fields — hidden until the AI has prepared a first draft, so the user is never
  // shown a half-populated form.
  const titleIn = el("input", { class: "input", value: book.title || "", maxlength: String(MAX_TITLE), placeholder: "Title" });
  const authorIn = el("input", { class: "input", value: book.author || "", maxlength: String(MAX_AUTHOR), placeholder: "Author (optional)" });
  const blurbIn = el("textarea", { class: "textarea", style: { minHeight: "110px" }, maxlength: String(MAX_BLURB), placeholder: "A short, spoiler-free description" });
  blurbIn.value = book.blurb || "";
  const tagSearch = el("input", { class: "input tag-search", type: "search", placeholder: "Filter tags…", autocomplete: "off" });
  const tagWrap = el("div", { class: "chips tag-cloud" });
  const tagNote = el("div", { class: "hint", style: { marginTop: "6px" } });
  const selectedTags = new Set((book.tags || []).slice(0, MAX_TAGS_PER_BOOK));
  const paintTags = () => {
    const q = tagSearch.value.trim().toLowerCase();
    tagWrap.innerHTML = "";
    let shown = 0;
    const ordered = [...TAGS].sort((a, b) => (selectedTags.has(b) ? 1 : 0) - (selectedTags.has(a) ? 1 : 0));
    for (const g of ordered) {
      if (q && !g.toLowerCase().includes(q)) continue;
      shown++;
      tagWrap.appendChild(el("button", {
        class: "chip sm" + (selectedTags.has(g) ? " active" : ""),
        onclick: () => {
          if (selectedTags.has(g)) selectedTags.delete(g);
          else if (selectedTags.size < MAX_TAGS_PER_BOOK) selectedTags.add(g);
          paintTags();
        },
      }, [g]));
    }
    if (!shown) tagWrap.appendChild(el("span", { class: "hint", text: "No matching tags" }));
    tagNote.textContent = selectedTags.size + "/" + MAX_TAGS_PER_BOOK + " selected";
  };
  tagSearch.addEventListener("input", paintTags);
  paintTags();

  const fieldsWrap = el("div", { hidden: true });
  fieldsWrap.appendChild(el("div", { class: "field" }, [el("label", { text: "Title" }), titleIn]));
  fieldsWrap.appendChild(el("div", { class: "field", style: { marginTop: "12px" } }, [el("label", { text: "Author" }), authorIn]));
  fieldsWrap.appendChild(el("div", { class: "field", style: { marginTop: "12px" } }, [el("label", { text: "Description" }), blurbIn]));
  fieldsWrap.appendChild(el("div", { class: "field", style: { marginTop: "12px" } }, [el("label", { text: "Tags (up to " + MAX_TAGS_PER_BOOK + ")" }), tagSearch, tagWrap, tagNote]));
  body.appendChild(fieldsWrap);

  const genSpinner = spinnerNode(16);
  const genLabel = el("span", { text: "Generating metadata…" });
  const genStatus = el("div", { class: "gen-status" }, [genSpinner, genLabel]);
  const publishBtn = el("button", { class: "btn btn-primary btn-block", style: { marginTop: "18px" }, disabled: true }, [icon("globe", { size: 17 }), "Publish to Explore"]);
  const statusEl = el("div", { class: "hint", style: { marginTop: "10px", textAlign: "center" } });
  body.append(genStatus, publishBtn, statusEl);
  const setGen = (text, loading) => {
    genLabel.textContent = text;
    genSpinner.hidden = !loading;
    genStatus.classList.toggle("err", !loading);
  };
  const setPublishBusy = (busy) => {
    publishBtn.innerHTML = "";
    if (busy) publishBtn.appendChild(spinnerNode(17));
    else publishBtn.insertAdjacentHTML("beforeend", icon("globe", { size: 17 }));
    publishBtn.appendChild(document.createTextNode(" Publish to Explore"));
  };

  openModal({ title: "Publish to Explore", body, className: "wide" });

  let text = book.text || (await store.getText(book.id));
  if (!text && book.textUrl) { try { text = await share.fetchText(book.textUrl); } catch (e) {} }
  let meta = null;
  let aiDraft = null;

  // Upload text + read it for catalogue data, in the background. The editable
  // fields stay hidden until this finishes so the form is never half-populated.
  (async () => {
    try {
      await ensureTextUrl(book);
      meta = await share.generateMetadata(text);
      titleIn.value = book.title || meta.title || titleIn.value;
      authorIn.value = book.author || meta.author || "";
      if (meta.blurb && !blurbIn.value) blurbIn.value = meta.blurb;
      if (meta.tags && meta.tags.length) {
        selectedTags.clear();
        meta.tags.slice(0, MAX_TAGS_PER_BOOK).forEach((g) => selectedTags.add(g));
      }
      paintTags();
      // Snapshot the model's own draft. If the author ships it untouched there
      // is nothing left to review, so publishing can skip the extra gate.
      aiDraft = {
        title: titleIn.value.trim(),
        author: authorIn.value.trim(),
        blurb: blurbIn.value.trim(),
        tags: Array.from(selectedTags),
      };
      genStatus.hidden = true;
      fieldsWrap.hidden = false;
      publishBtn.disabled = false;
    } catch (e) {
      console.warn(e);
      setGen("Couldn't reach the tagging service — fill in the details below and publish.", false);
      fieldsWrap.hidden = false;
      publishBtn.disabled = false;
    }
  })();

  const draftDirty = () => {
    if (!aiDraft) return true;
    const sameTags = selectedTags.size === aiDraft.tags.length && aiDraft.tags.every((g) => selectedTags.has(g));
    return titleIn.value.trim() !== aiDraft.title
      || authorIn.value.trim() !== aiDraft.author
      || blurbIn.value.trim() !== aiDraft.blurb
      || !sameTags;
  };

  publishBtn.addEventListener("click", async () => {
    publishBtn.disabled = true;
    const setStatus = (t) => { statusEl.textContent = t; };
    try {
      setStatus("Uploading text…");
      const textUrl = await ensureTextUrl(book);

      setStatus("Preparing cover art…");
      let coverUrl = book.coverUrl || "";
      let localBlob = null;
      if (coverState.blob) {
        localBlob = coverState.blob;
        const up = await share.uploadBlob(localBlob);
        coverUrl = up.url;
      } else if (coverUrl) {
        // Already uploaded (e.g. a cover that came with an Explore listing).
      } else if (book.coverLocal) {
        // A cover the user added; publishing is the moment it's uploaded.
        coverUrl = await ensureCoverUrl(book);
      } else if (meta && meta.coverPrompt) {
        try {
          setStatus("Painting cover art…");
          localBlob = (await share.generateCover(meta)).blob;
          const up = await share.uploadBlob(localBlob);
          coverUrl = up.url;
        } catch (e) { console.warn("cover:", e); localBlob = null; }
      }
      if (localBlob) {
        try { await store.putCover(book.id, localBlob); covers.set(book.id, localBlob); } catch (e) {}
      }
      coverState.url = coverUrl || coverState.url;
      applyCoverToBook(book, { coverLocal: !!book.coverLocal || !!localBlob, coverUrl });

      // The metadata was written (and already tidied) by the same model, so an
      // untouched draft needs no second pass. Only a hand-edited listing goes
      // through the gate — and even then we surface nothing beyond the busy
      // spinner, so the check itself isn't advertised to a tampering client.
      let moderation = null;
      if (draftDirty()) {
        setStatus("");
        setPublishBusy(true);
        moderation = await share.moderateListing({
          title: titleIn.value.trim() || book.title,
          author: authorIn.value.trim(),
          blurb: blurbIn.value.trim(),
          tags: Array.from(selectedTags),
        });
        setPublishBusy(false);
        if (!moderation.ok) throw new Error(moderation.reason);
      }

      const reviewed = moderation && !moderation.failed;
      const finalTitle = reviewed ? moderation.title : (titleIn.value.trim() || book.title);
      const finalAuthor = reviewed ? moderation.author : authorIn.value.trim();
      const finalBlurb = reviewed ? moderation.blurb : blurbIn.value.trim();
      const finalTags = ((reviewed && moderation.tags && moderation.tags.length) ? moderation.tags : Array.from(selectedTags)).slice(0, MAX_TAGS_PER_BOOK);

      // Show the reviewer's cleanup in the form, so the author sees what shipped.
      titleIn.value = finalTitle;
      authorIn.value = finalAuthor;
      blurbIn.value = finalBlurb;
      selectedTags.clear();
      finalTags.forEach((g) => selectedTags.add(g));
      paintTags();

      setStatus("Adding to Explore…");
      const patch = {
        title: finalTitle,
        author: finalAuthor,
        blurb: finalBlurb,
        tags: finalTags,
        tagBits: tagBitsFromNames(finalTags),
        coverUrl,
        textUrl,
      };
      if (localBlob) patch.coverLocal = true;
      Object.assign(book, patch);
      await store.patchBook(book.id, patch);

      // Bundle everything bulky into one small json upload; the server listing
      // keeps only its id plus the numeric metadata it searches/sorts on.
      const bundle = await share.publishBundle(book, app.bookVoice(book));
      const rec = share.buildServerRecord(book, text, bundle.id);
      const res = await app.net.submit(rec);
      if (!res.ok) {
        if (res.error === "rate_limited") throw new Error("You've published several books recently — please try again later.");
        if (res.error === "toolong") throw new Error("One of the fields is too long.");
        throw new Error("Server said: " + res.error);
      }
      book.seq = res.seq;
      await store.patchBook(book.id, { seq: res.seq });
      if (app.currentBook && app.currentBook.id === book.id) app.currentBook.seq = res.seq;
      loadLibrary();
      setStatus("");
      const doneBody = el("div");
      doneBody.appendChild(el("p", { text: res.deduped ? "This audiobook was already in Explore — here it is." : "Published! It's now in the public Explore listing." }));
      doneBody.appendChild(el("p", { class: "hint", text: "You can keep listening on this device, and its share link keeps working even if it later leaves the listing." }));
      openModal({
        title: "Published", body: doneBody,
        actions: [
          { label: "View in Explore", class: "btn-primary", onClick: () => { closeModal(); navigate("explore"); } },
          { label: "Done", class: "btn-ghost", onClick: closeModal },
        ],
      });
    } catch (e) {
      console.warn(e);
      setStatus("");
      setPublishBusy(false);
      publishBtn.disabled = false;
      toast(e.message || "Publishing failed", { type: "error", timeout: 6000 });
    }
  });
}

// ===========================================================================
// Deep links (shared audiobooks)
// ===========================================================================
// Share links are `?b=<upload-id>`. The query string (rather than a hash) is
// what lets `$meta.dynamic` in main.pjs read the same id server-side and emit
// per-book title/description/cover metadata for link previews.
function readDeepLink() {
  try {
    const b = new URLSearchParams(location.search).get("b");
    return b && /^[A-Za-z0-9_-]+$/.test(b) ? b : null;
  } catch (e) { return null; }
}

function setupDeepLink() {
  const open = async () => {
    const payload = readDeepLink();
    if (!payload) return;
    const book = await share.resolveSharePayload(payload);
    if (!book) { toast("That share link looks broken", { type: "error" }); return; }
    // The shared file's real tags are checked here at open time — the sharer
    // can't smuggle an unsafe file past the filter by lying in the metadata.
    if (app.settings.safeMode) {
      try {
        const textNsfw = await nsfwForUrl(book.textUrl);
        const coverNsfw = book.coverUrl ? await nsfwForUrl(book.coverUrl) : false;
        if (textNsfw || coverNsfw) book.nsfw = true;
      } catch (e) {}
    }
    if (book.nsfw && app.settings.safeMode) {
      openModal({
        title: "Content warning",
        body: "This audiobook is marked NSFW. Your content filter is on. You can still listen to it on this device.",
        actions: [
          { label: "Go back", class: "btn-ghost", onClick: closeModal },
          { label: "Listen anyway", class: "btn-primary", onClick: () => { closeModal(); openBook(book); } },
        ],
      });
    } else {
      openBook(book);
    }
  };
  open();
  window.addEventListener("popstate", () => { if (readDeepLink()) open(); });
}

// ===========================================================================
// Settings
// ===========================================================================
let sleepTimer = null;
function applySleep(minutes) {
  app.sleepMinutes = minutes;
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
  if (minutes > 0) {
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      app.sleepMinutes = 0;
      if (app.player && app.player.isPlaying) app.player.pause();
      toast("Sleep timer — playback paused");
    }, minutes * 60 * 1000);
  }
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

function openSettings() {
  const body = el("div");

  // --- Appearance -----------------------------------------------------------
  const themeField = el("div", { class: "field" });
  themeField.appendChild(el("label", { text: "Appearance" }));
  const themeWrap = el("div", { class: "chips" });
  const paintTheme = () => {
    themeWrap.innerHTML = "";
    for (const [v, label] of [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"], ["black", "Black"]]) {
      themeWrap.appendChild(el("button", { class: "chip" + (app.settings.theme === v ? " active" : ""), onclick: () => { app.settings.theme = v; store.setSetting("theme", v); applyTheme(); paintTheme(); } }, [label]));
    }
  };
  paintTheme();
  themeField.appendChild(themeWrap);
  body.appendChild(themeField);

  body.appendChild(el("div", { class: "divider" }));

  // --- Playback -------------------------------------------------------------
  const playback = el("div", { class: "field" });
  playback.appendChild(el("label", { text: "Default narrator" }));
  const voiceSelect = el("select", { class: "select" });
  const light = ALL_VOICES.filter((v) => LIGHT_VOICE_IDS.includes(v.id));
  const featured = ALL_VOICES.filter((v) => FEATURED_VOICE_IDS.includes(v.id));
  const others = ALL_VOICES.filter((v) => !FEATURED_VOICE_IDS.includes(v.id) && !LIGHT_VOICE_IDS.includes(v.id));
  const og0 = el("optgroup", { label: "Light & fast" });
  for (const v of light) og0.appendChild(el("option", { value: v.id, text: `${v.name} · ${v.gender} · ${v.tag || "tiny download"}` }));
  const og1 = el("optgroup", { label: "Recommended" });
  for (const v of featured) og1.appendChild(el("option", { value: v.id, text: `${v.name} · ${v.gender}` }));
  const og2 = el("optgroup", { label: "More voices" });
  for (const v of others) og2.appendChild(el("option", { value: v.id, text: `${v.name} · ${v.gender} · ${v.lang === "en-gb" ? "UK" : "US"}` }));
  voiceSelect.append(og0, og1, og2);
  voiceSelect.value = app.settings.voice;
  voiceSelect.addEventListener("change", () => {
    app.settings.voice = voiceSelect.value;
    store.setSetting("voice", voiceSelect.value);
    if (app.create) {
      app.create.voice = voiceSelect.value;
      if (app.create.refs && app.create.refs.voiceSelect) app.create.refs.voiceSelect.value = voiceSelect.value;
    }
    // Books with their own narrator keep it; books on the default follow along.
    const book = app.player.book;
    if (book && !book.voice) { app.player.setVoice(app.settings.voice); app.failedChunks.clear(); }
    toast("Default narrator: " + voiceLabel(voiceSelect.value));
  });
  const prevBtn = el("button", { class: "icon-btn voice-prev", title: "Preview voice", "aria-label": "Preview voice", html: icon("play", { size: 18 }) });
  prevBtn.addEventListener("click", () => previewVoice(voiceSelect.value, prevBtn));
  playback.appendChild(el("div", { class: "voice-pick" }, [voiceSelect, prevBtn]));
  playback.appendChild(el("div", { class: "hint", style: { marginTop: "2px" }, text: "Used for new audiobooks. Any audiobook can be given its own narrator from its options." }));
  body.appendChild(playback);

  const sizeField = el("div", { class: "field", style: { marginTop: "16px" } });
  sizeField.appendChild(el("label", { text: "Text size" }));
  const sizeWrap = el("div", { class: "chips" });
  const SIZE_LABELS = ["Small", "Default", "Large", "X-Large", "Huge"];
  const paintSize = () => {
    sizeWrap.innerHTML = "";
    FONTS.forEach((v, i) => {
      sizeWrap.appendChild(el("button", { class: "chip" + (app.settings.fontSize === v ? " active" : ""), onclick: () => {
        app.settings.fontSize = v;
        store.setSetting("fontSize", v);
        document.documentElement.style.setProperty("--reader-scale", v);
        paintSize();
      } }, [SIZE_LABELS[i] || v + "×"]));
    });
  };
  paintSize();
  sizeField.appendChild(sizeWrap);
  body.appendChild(sizeField);

  const readingField = el("div", { class: "field", style: { marginTop: "16px" } });
  readingField.appendChild(el("label", { text: "Reading" }));
  const readingWrap = el("div", { class: "chips" });
  const paintReading = () => {
    readingWrap.innerHTML = "";
    readingWrap.appendChild(el("button", { class: "chip" + (app.settings.autoScroll ? " active" : ""), onclick: () => {
      app.settings.autoScroll = !app.settings.autoScroll;
      store.setSetting("autoScroll", app.settings.autoScroll);
      if (app.settings.autoScroll) scrollActiveIntoView(true);
      updateScrollReturn();
      paintReading();
    } }, ["Auto-scroll"]));
  };
  paintReading();
  readingField.appendChild(readingWrap);

  const sleepWrap = el("div", { class: "sleep-row", style: { marginTop: "12px" } });
  sleepWrap.appendChild(el("span", { class: "sleep-label" }, [icon("clock", { size: 15 }), "Sleep timer"]));
  const sleepSel = el("select", { class: "select sleep-select" });
  for (const opt of SLEEP_OPTIONS) sleepSel.appendChild(el("option", { value: String(opt.value), text: opt.label }));
  sleepSel.value = String(app.sleepMinutes || 0);
  sleepSel.addEventListener("change", () => {
    const m = +sleepSel.value || 0;
    applySleep(m);
    if (m > 0) toast("Sleep timer set for " + (SLEEP_OPTIONS.find((o) => o.value === m) || {}).label);
  });
  app._sleepSelect = sleepSel;
  sleepWrap.appendChild(sleepSel);
  readingField.appendChild(sleepWrap);
  body.appendChild(readingField);

  body.appendChild(el("div", { class: "divider" }));

  // --- Audio & storage ------------------------------------------------------
  const clearBtn = el("button", { class: "btn btn-ghost btn-block" }, [icon("trash", { size: 17 }), "Clear cached audio"]);
  clearBtn.addEventListener("click", async () => {
    clearBtn.disabled = true;
    try {
      await storage.folder("chunkCache").clear();
      await storage.folder("chunkCacheMeta").clear();
      clearBtn.lastChild.textContent = "Clear cached audio";
      toast("Cached audio cleared");
    } catch (e) {
      toast("Couldn't clear the cache", { type: "error" });
      clearBtn.disabled = false;
    }
  });
  body.appendChild(clearBtn);

  (async () => {
    try {
      const entries = await storage.folder("chunkCacheMeta").entries();
      const bytes = entries.reduce((s, [, d]) => s + ((d && d.size) || 0), 0);
      if (bytes > 0) clearBtn.lastChild.textContent = "Clear cached audio (" + fmtBytes(bytes) + ")";
      else clearBtn.disabled = true;
    } catch (e) {}
  })();

  const storageLine = el("div", { class: "hint", style: { marginTop: "12px" } });
  body.appendChild(storageLine);
  storage.init().then(() => { storageLine.textContent = "Storage: " + storage.backendLabel(); }).catch(() => {});

  openModal({ title: "Settings", body });
}

// ===========================================================================
// Create pane: draft persistence + whole-page file drop
// ===========================================================================
let createDraftTimer = null;

// Debounced so typing doesn't hammer kv; the pending write is flushed when the
// tab is hidden or unloaded so nothing is lost.
function saveCreateDraft() {
  clearTimeout(createDraftTimer);
  createDraftTimer = setTimeout(flushCreateDraft, 600);
}

function flushCreateDraft() {
  clearTimeout(createDraftTimer);
  if (!app.create) return;
  store.saveCreateDraft({ text: app.create.text || "", voice: app.create.voice || app.settings.voice });
}

// ===========================================================================
// Reformat text (AI cleanup of an imported/pasted document)
//
// One segment at a time, sequentially: the ai-text-plugin allows only a few
// concurrent requests per user, and sequential processing is what lets the
// Create pane show every edit as it lands. `Reformatter` owns the chunking,
// the prompt and the edit protocol (see reformat.js); this is just the glue
// between it and the plugin + the live stage.
// ===========================================================================
function reformatGenerate(instruction, onChunk) {
  return root.generateText({
    instruction,
    onChunk: (d) => { if (onChunk) onChunk(d.textChunk || ""); },
  }).then((res) => {
    // PORT: the shim returns { error } instead of { text } off-Perchance; turn
    // it into a real failure so the reformat stage marks segments failed
    // rather than trying to parse an error object as model output.
    if (res && res.error) throw new Error(res.error);
    return res;
  });
}

function runReformat({ text, task, maxWords = 360, hooks = {} } = {}) {
  stopReformat();
  const r = new Reformatter({
    generate: reformatGenerate,
    maxWords,
    onStart: hooks.onStart,
    onSegmentStart: hooks.onSegmentStart,
    onSegmentDelta: (i, chunk, raw) => { if (hooks.onSegmentDelta) hooks.onSegmentDelta(i, chunk, raw); },
    onSegmentEnd: hooks.onSegmentEnd,
    onFinish: hooks.onFinish,
  });
  app.reformat.run = r;
  return r.run(text, task)
    .then((summary) => {
      if (app.reformat.run === r) app.reformat.run = null;
      return summary;
    })
    .catch((e) => {
      if (app.reformat.run === r) app.reformat.run = null;
      console.error("reformat failed:", e);
      if (hooks.onError) hooks.onError(e);
    });
}

function stopReformat() {
  if (app.reformat.run) { app.reformat.run.stop(); app.reformat.run = null; }
}

async function runReformatSegment({ segLines, task, index = 0, total = 1, hooks = {} } = {}) {
  const r = new Reformatter({
    generate: reformatGenerate,
    onSegmentDelta: (i, chunk, raw) => { if (hooks.onSegmentDelta) hooks.onSegmentDelta(i, chunk, raw); },
  });
  return r.processSegment(segLines, task, index, total);
}

// A file dropped anywhere on the Create page is handled like "Open a file…".
// Active only while that route is showing; refs come from the current render.
function setupCreateDrop() {
  const refs = () => app.create && app.create.refs;
  const hot = (on) => { const r = refs(); if (r && r.dz) r.dz.classList.toggle("drag", on); };
  const carriesFiles = (e) => Array.prototype.indexOf.call((e.dataTransfer && e.dataTransfer.types) || [], "Files") !== -1;
  document.addEventListener("dragenter", (e) => { if (app.route !== "create" || !carriesFiles(e)) return; e.preventDefault(); hot(true); });
  document.addEventListener("dragover", (e) => {
    if (app.route !== "create" || !carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    hot(true);
  });
  document.addEventListener("dragleave", (e) => { if (e.relatedTarget) return; hot(false); });
  window.addEventListener("blur", () => hot(false));
  document.addEventListener("drop", (e) => {
    if (app.route !== "create" || !carriesFiles(e)) return;
    e.preventDefault();
    hot(false);
    const r = refs();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && r && r.acceptFile) r.acceptFile(f);
  });
}

// ===========================================================================
// Keyboard
// ===========================================================================
function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (isModalOpen()) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
    if (e.key === " " || e.key === "k") {
      if (!app.player.book) return;
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowRight" && !e.altKey) {
      if (app.playerOpen && app.player.book) { e.preventDefault(); app.player.skip(30); }
    } else if (e.key === "ArrowLeft" && !e.altKey) {
      if (app.playerOpen && app.player.book) { e.preventDefault(); app.player.skip(-10); }
    } else if (e.key === "Escape") {
      if (app.playerOpen) closePlayerScreen();
    }
  });
}

// ===========================================================================
// Device sync
// ===========================================================================
// The coordination server only relays tiny encrypted control frames; the books
// themselves travel device-to-device (see src/devicesync.js). This UI is just a
// thin, honest window onto that: pair, see who's connected, sync on demand.
function setupDeviceSync() {
  const eng = devicesync.engine;
  devicesync.setNowPlaying(() => (app.player && app.player.book && app.player.book.id) || null);
  // On a cache miss the TTS engine asks this fetcher for the audio before
  // synthesising it, so a low-powered device can pull already-generated chunks
  // from a linked peer (see the chunk broker in src/devicesync.js).
  devicesync.setChunkStore({ get: getCachedChunk, put: putCachedChunk });
  setChunkFetcher((key) => eng.fetchChunk(key), () => eng.peers.size > 0);
  // Re-arm the whole-book prefetch whenever a peer shows up, so chunks that were
  // missing (or fetched before this device was linked) are asked for again.
  let lastPeerCount = 0;
  eng.onUpdate(() => {
    const n = eng.peers ? eng.peers.size : 0;
    if (n > 0 && n !== lastPeerCount && app.engine && app.engine.kickPrefetch) {
      try { app.engine.kickPrefetch(); } catch (e) {}
    }
    lastPeerCount = n;
  });
  eng.init().then(() => { if (eng.secretBytes) eng.setPresence(true); }).catch(() => {});
  // Fold whatever a sync session changed into the in-memory views.
  eng.onSynced = async (summary) => {
    if (!summary || (summary.recv + summary.deletes) === 0) return;
    await loadLibrary();
    await loadCollections();
    await loadBookmarks();
    if (app.route === "library") renderLibrary(app);
  };
  // A ?sync=<secret> invite: offer to join this device to the group.
  let secret = null;
  try { secret = new URLSearchParams(location.search).get("sync"); } catch (e) {}
  if (secret) setupSyncInvite(secret);
}

function setupSyncInvite(secret) {
  try {
    const u = new URL(location.href);
    u.searchParams.delete("sync");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  } catch (e) {}
  openModal({
    title: "Link this device?",
    body: el("div", {}, [
      el("p", { text: "This link adds this device to a syncing group. Your audiobooks, folders, bookmarks and playback positions will be kept in step with the other device(s) in the group." }),
      el("p", { class: "hint", text: "The link is the key to the group — anyone who has it can join the sync. Treat it like a password." }),
    ]),
    actions: [
      { label: "Not now", class: "btn-ghost", onClick: closeModal },
      {
        label: "Link this device", class: "btn-primary", onClick: async () => {
          try {
            await devicesync.engine.init();
            await devicesync.engine.acceptInvite(secret);
            devicesync.engine.setPresence(true);
            closeModal();
            toast("Device linked");
            openDeviceSyncModal();
          } catch (e) { toast("That sync link looks broken", { type: "error" }); }
        },
      },
    ],
  });
}

function readSyncSecret(input) {
  const v = String(input || "").trim();
  if (!v) return "";
  const m = v.match(/[?&]sync=([A-Za-z0-9_-]+)/);
  return m ? m[1] : v;
}

function openDeviceSyncModal() {
  const eng = devicesync.engine;
  const host = el("div", { class: "device-sync" });
  const body = el("div", {}, [host]);

  let painted = false;
  const paint = () => {
    const s = eng.getStatus();
    host.innerHTML = "";
    if (!s.linked) { host.appendChild(syncIntro()); painted = true; return; }
    host.appendChild(syncLinked(s));
    painted = true;
  };
  const schedulePaint = (() => {
    let raf = 0;
    return () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (painted) paint(); }); };
  })();

  function syncIntro() {
    const wrap = el("div", { class: "sync-box" });
    wrap.appendChild(el("div", { class: "sync-head" }, [
      el("span", { class: "sync-ic", html: icon("sync", { size: 18 }) }),
      el("b", { text: "One library, all your devices" }),
    ]));
    wrap.appendChild(el("p", { class: "hint", text: "Pair this device with your other device(s) using a private link. Books, folders, bookmarks and playback positions stay in step. If a book is already narrated on another device, this one plays it straight away by pulling the audio from there instead of re-generating it." }));
    const createBtn = el("button", { class: "btn btn-primary btn-block", style: { marginTop: "12px" } }, [icon("link", { size: 17 }), "Create a sync link"]);
    createBtn.addEventListener("click", async () => {
      createBtn.disabled = true;
      try {
        await eng.createInvite();
        eng.setPresence(true);
        paint();
        eng.setActive(true);
        eng.syncNow().catch(() => {});
      } catch (e) {
        createBtn.disabled = false;
        toast("Couldn't create a sync link", { type: "error" });
      }
    });
    wrap.appendChild(createBtn);

    wrap.appendChild(el("div", { class: "divider" }));
    wrap.appendChild(el("p", { class: "hint", text: "Already set up on another device? Paste its sync link or code below." }));
    const input = el("input", { class: "input", type: "text", placeholder: "https://perchance.org/…?sync=…", spellcheck: "false", autocapitalize: "off" });
    const joinBtn = el("button", { class: "btn btn-ghost" }, ["Link"]);
    const joinRow = el("div", { class: "share-link-row", style: { marginTop: "8px" } }, [input, joinBtn]);
    const doJoin = async () => {
      const secret = readSyncSecret(input.value);
      if (!secret) { toast("Paste a sync link first", { type: "error" }); return; }
      try { await eng.acceptInvite(secret); toast("Device linked"); paint(); eng.setActive(true); eng.syncNow().catch(() => {}); }
      catch (e) { toast("That doesn't look like a valid sync code", { type: "error" }); }
    };
    joinBtn.addEventListener("click", doJoin);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
    wrap.appendChild(joinRow);
    return wrap;
  }

  function syncLinked(s) {
    const wrap = el("div");
    const box = el("div", { class: "sync-box" });
    box.appendChild(el("div", { class: "sync-head" }, [
      el("span", { class: "sync-ic", html: icon("sync", { size: 18 }) }),
      el("b", { text: "Syncing with your devices" }),
    ]));
    box.appendChild(el("p", { class: "hint", text: "Group fingerprint — it must read the same on every device:" }));
    box.appendChild(el("code", { class: "sync-fp", text: s.fingerprint || "…" }));

    // Peers
    if (s.peers.length) {
      const list = el("div", { class: "sync-peers" });
      for (const p of s.peers) {
        const state = p.finished ? "Up to date" : (p.transport === "direct" ? "Direct connection" : (p.transport === "relay" ? "Secure relay" : "Connecting…"));
        list.appendChild(el("div", { class: "sync-peer" }, [
          el("span", { class: "dot " + (p.finished ? "ok" : "busy") }),
          el("span", { class: "sync-peer-name", text: p.name || "Device" }),
          el("span", { class: "hint", text: state }),
        ]));
      }
      box.appendChild(list);
    } else {
      box.appendChild(el("p", { class: "hint", text: s.requested && s.state !== "error" ? "Waiting for your other device to come online…" : "Open this screen on your other device to sync." }));
    }

    const status = el("div", { class: "hint sync-status" });
    if (s.error === "offline") status.textContent = "Couldn't reach the sync service. Check your connection and try again.";
    else if (s.peers.some((p) => p.sent || p.recv)) status.textContent = "Last sync moved " + (s.peers.reduce((n, p) => n + p.recv, 0)) + " item(s) in.";
    else if (s.lastSyncAt) status.textContent = "Last synced " + timeAgo(s.lastSyncAt) + ".";
    box.appendChild(status);

    const nowBtn = el("button", { class: "btn btn-primary" }, [icon("sync", { size: 16 }), "Sync now"]);
    nowBtn.addEventListener("click", () => {
      eng.setActive(true);
      eng.syncNow().then((sum) => {
        if (!sum.peers.length) toast("No other device connected yet");
      }).catch(() => toast("Sync failed", { type: "error" }));
    });
    const copyBtn = el("button", { class: "btn btn-ghost" }, [icon("link", { size: 16 }), "Copy invite link"]);
    copyBtn.addEventListener("click", async () => {
      const url = await eng.createInvite();
      const ok = await copyText(url);
      toast(ok ? "Invite link copied" : "Couldn't copy — here it is: " + url, { type: ok ? "info" : "error", timeout: 6000 });
    });
    box.appendChild(el("div", { class: "chips", style: { marginTop: "14px" } }, [nowBtn, copyBtn]));

    const linkRow = el("div", { class: "share-link-row", style: { marginTop: "10px" } });
    const linkInput = el("input", { class: "input", type: "text", readonly: true, value: eng.linkUrl(), spellcheck: "false" });
    linkInput.addEventListener("focus", () => linkInput.select());
    linkRow.appendChild(linkInput);
    box.appendChild(linkRow);

    wrap.appendChild(box);

    wrap.appendChild(el("div", { class: "divider" }));
    wrap.appendChild(el("p", { class: "hint", text: "Synced: books, folders, bookmarks and playback positions. Kept on each device only: your settings, drafts and generated audio (though already-narrated audio is shared device-to-device on demand, so a book made on one device plays quickly on the others)." }));
    const offBtn = el("button", { class: "btn btn-ghost btn-block", style: { marginTop: "10px" } }, [icon("close", { size: 16 }), "Stop syncing this device"]);
    offBtn.addEventListener("click", () => {
      openModal({
        title: "Stop syncing?",
        body: "This device stops syncing with the group. Nothing is deleted from any device — you can link it again later.",
        actions: [
          { label: "Cancel", class: "btn-ghost", onClick: closeModal },
          { label: "Stop syncing", class: "btn-danger", onClick: async () => { closeModal(); await eng.unlink(); paint(); } },
        ],
      });
    });
    wrap.appendChild(offBtn);

    return wrap;
  }

  openModal({
    title: "Device sync",
    body,
    onClose: () => { eng.setActive(false); unsubscribe(); },
  });
  const unsubscribe = eng.onUpdate(schedulePaint);
  eng.setActive(true);
  paint();
  // Nudge an immediate session if a peer is already around.
  eng.syncNow().catch(() => {});
}

// ===========================================================================
// expose the API used by views.js
// ===========================================================================
Object.assign(app, {
  openDeviceSyncModal,
  navigate, showRoute, loadExplore, loadLibrary, loadCollections, openBook, createBook, countChunks,
  openShareModal, openBookMenu, openSettings, previewVoice, updateEngineStatus, tickEngineIdle,
  setSearch, openPublishModal,
  closePlayerScreen, togglePlay, bookVoice,
  setCollection, setLibraryArchived, newFolder, folderMenu, handleDrop,
  folderContextMenu,
  setLibraryFilter, toggleLibraryTag, clearLibraryFilters,
  addBookToCollection, ensureLocalBook, moveFolder, reorderBook, movePosition, sortByOrder, playCollection,
  openBackupModal, pickImportFile, openAddModal, toggleArchive, markUnread, markRead, openVoicePicker, bookContextMenu,
  setLibraryBookmarks, setBookmarkTag, loadBookmarks, bookmarkHere,
  playBookmarkQueue, jumpToQueueItem, openBookmarkSpot, advanceBookmarkQueue, exitBookmarkQueue,
  openBookmarkMenu, openTagManager, renameBookmarkTag, deleteBookmarkTag,
  saveCreateDraft, stopReformat, runReformat, runReformatSegment,
});

boot().catch((e) => {
  console.error("boot failed:", e);
  const host = $("#viewExplore");
  if (host) host.innerHTML = "";
  if (host) host.appendChild(el("div", { class: "empty" }, [el("h3", { text: "Something went wrong" }), el("p", { text: String(e && e.message || e) })]));
  if (window.__boot) window.__boot.ready();
});

export default app;
