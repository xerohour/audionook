// ===========================================================================
// ui.js — small shared presentational builders (cover art, cards, chips,
// empty states) used by the views and the player screen.
// ===========================================================================

import { el, icon, coverStyle, coverInitial, fnv1a, formatLongDuration, formatCompact } from "./util.js";
import { WORDS_PER_MINUTE, bookHue } from "./config.js";
import { coverUrlFor } from "./covers.js";

export function estimateDurationSec(book) {
  const words = book && book.wordCount ? book.wordCount : 0;
  return Math.max(1, Math.round((words / WORDS_PER_MINUTE) * 60));
}

export function durationLabel(book) {
  if (!book) return "";
  if (book.durationSec) return formatLongDuration(book.durationSec);
  if (book.wordCount) return "~" + formatLongDuration(estimateDurationSec(book));
  return "";
}

export function listensLabel(sec) {
  sec = Number(sec) || 0;
  if (sec < 1) return "No listens yet";
  if (sec < 90) return Math.round(sec) + "s listened";
  return formatLongDuration(sec) + " listened";
}

export function playsLabel(n) {
  n = Number(n) || 0;
  if (!n) return "No plays yet";
  return formatCompact(n) + (n === 1 ? " play" : " plays");
}

// --- cover art --------------------------------------------------------------
export function coverNode(book, { showPlay = false, className = "" } = {}) {
  const wrap = el("div", { class: "cover" + (className ? " " + className : "") });
  fillCover(wrap, book);
  // Only an adult-content badge is overlaid on the art, and only when the host's
  // own file tags flagged this book (there is no declared rating) so it never
  // competes with the title otherwise.
  if (book && book.nsfw) {
    wrap.classList.add("has-tag");
    wrap.appendChild(el("span", { class: "chip-adult cover-tag", text: "18+" }));
  }
  if (showPlay) {
    const badge = el("div", { class: "play-badge", "aria-hidden": "true" });
    badge.appendChild(el("span", { class: "pb-play", html: icon("play", { size: 16 }) }));
    badge.appendChild(el("span", { class: "pb-eq", html: "<i></i><i></i><i></i><i></i>" }));
    wrap.appendChild(badge);
  }
  return wrap;
}

function fillCover(wrap, book) {
  book = book || {};
  const src = coverUrlFor(book);
  if (src) {
    const img = el("img", { src, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => { img.remove(); paintProceduralCover(wrap, book); }, { once: true });
    wrap.appendChild(img);
  } else {
    paintProceduralCover(wrap, book);
  }
}

// A designed "book cover" made from the title + author, sized by container query
// so it reads correctly in a 44px mini-player thumbnail and a 300px hero alike.
export function paintProceduralCover(wrap, book) {
  book = book || {};
  wrap.style.background = coverStyle(book.id || book.title || "audiobook", bookHue(book));
  if (!book.title) {
    wrap.appendChild(el("div", { class: "initial", text: coverInitial(book.id || "A") }));
    return;
  }
  const variant = fnv1a(book.id || book.title || "x") % 8;
  const mark = (variant === 4 || variant === 5) ? el("div", { class: "cover-mark", text: coverInitial(book.title || book.id || "A") }) : null;
  const tlen = (book.title || "").length;
  const titleCls = "cover-title" + (tlen > 40 ? " t-xl" : tlen > 26 ? " t-lg" : "");
  wrap.appendChild(el("div", { class: "cover-art v" + variant }, [
    mark,
    el("div", { class: titleCls, text: book.title }),
    book.author ? el("div", { class: "cover-author", text: book.author }) : null,
  ]));
}

// --- cards ------------------------------------------------------------------
export function bookCard(book, opts = {}) {
  const { onOpen, progress = null, onLongPress = null, current = false, playing = false } = opts;
  const card = el("div", { class: "card", role: "button", tabindex: "0" });
  if (book && book.id != null) card.dataset.bookId = String(book.id);
  if (current) card.classList.add("current");
  if (current && playing) card.classList.add("playing");
  const cover = coverNode(book, { showPlay: true });
  // Always build the bar (hidden when there's nothing to show) so the playing
  // card can be updated live without rebuilding the card.
  const bar = el("div", { class: "card-progress", hidden: !(current || (progress && progress > 0.005)) });
  bar.appendChild(el("i", { style: { width: Math.min(100, Math.max(0, (progress || 0) * 100)) + "%" } }));
  cover.appendChild(bar);
  card._progressBar = bar;
  card._progressFill = bar.firstChild;
  card.appendChild(cover);
  const meta = [book.author, durationLabel(book)];
  if (book.origin === "explore" && book.tags && book.tags.length) meta.push(book.tags.slice(0, 2).join(", "));
  const body = el("div", { class: "card-body" }, [
    el("div", { class: "card-title", text: book.title || "Untitled" }),
    el("div", { class: "card-meta", text: meta.filter(Boolean).join(" · ") || "Ready to listen" }),
  ]);
  card.appendChild(body);
  const open = () => { if (onOpen) onOpen(book); };
  let suppressClick = false;
  card.addEventListener("click", () => { if (suppressClick) { suppressClick = false; return; } open(); });
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  if (onLongPress) {
    let timer = null;
    let point = null;
    const fire = (pos) => { suppressClick = true; onLongPress(book, pos || {}); };
    const start = (e) => {
      point = { x: e.clientX || 0, y: e.clientY || 0 };
      timer = setTimeout(() => { timer = null; fire(point); }, 500);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    card.addEventListener("pointerdown", start);
    card.addEventListener("pointerup", cancel);
    card.addEventListener("pointerleave", cancel);
    card.addEventListener("pointercancel", cancel);
    card.addEventListener("pointermove", (e) => {
      if (!timer || !point) return;
      if (Math.abs(e.clientX - point.x) > 8 || Math.abs(e.clientY - point.y) > 8) cancel();
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cancel();
      fire({ x: e.clientX, y: e.clientY });
    });
  }
  return card;
}

// A collection tile. Doubles as a drag-and-drop target (the caller wires the
// drag events since it owns the app state).
export function folderCard(col, { count = 0, onOpen, onMenu, onContext } = {}) {
  const card = el("div", { class: "folder-card", role: "button", tabindex: "0" });
  card.appendChild(el("div", { class: "folder-ic", html: icon("folder", { size: 18 }) }));
  const body = el("div", { class: "folder-body" }, [
    el("div", { class: "folder-name", text: col.name || "Folder" }),
    el("div", { class: "folder-count", text: count === 1 ? "1 audiobook" : count + " audiobooks" }),
  ]);
  card.appendChild(body);
  if (onMenu) {
    const menu = el("button", { class: "card-menu folder-menu", title: "Collection options", html: "⋯" });
    menu.addEventListener("click", (e) => { e.stopPropagation(); onMenu(); });
    card.appendChild(menu);
  }
  const open = () => { if (onOpen) onOpen(col); };
  const openCtx = (pos) => { if (onContext) onContext(col, pos || {}); else if (onMenu) onMenu(); };
  let suppressClick = false;
  card.addEventListener("click", () => { if (suppressClick) { suppressClick = false; return; } open(); });
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  if (onContext || onMenu) {
    card.addEventListener("contextmenu", (e) => { e.preventDefault(); suppressClick = true; openCtx({ x: e.clientX, y: e.clientY }); });
    let timer = null;
    let point = null;
    const fire = (pos) => { suppressClick = true; openCtx(pos); };
    const start = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      point = { x: e.clientX || 0, y: e.clientY || 0 };
      timer = setTimeout(() => { timer = null; fire(point); }, 500);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    card.addEventListener("pointerdown", start);
    card.addEventListener("pointerup", cancel);
    card.addEventListener("pointerleave", cancel);
    card.addEventListener("pointercancel", cancel);
    card.addEventListener("pointermove", (e) => {
      if (!timer || !point) return;
      if (Math.abs(e.clientX - point.x) > 8 || Math.abs(e.clientY - point.y) > 8) cancel();
    });
  }
  return card;
}

export function hiddenCard(reason = "Hidden by your content filter") {  return el("div", { class: "card" }, [
    el("div", { class: "card-hidden" }, [icon("globe", { size: 26 }), el("span", { text: reason })]),
  ]);
}

export function skeletonCards(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(el("div", { class: "skeleton skel-card" }));
  return out;
}

// --- misc -------------------------------------------------------------------
export function chip(label, { active = false, onClick = null, title = "" } = {}) {
  return el("button", { class: "chip" + (active ? " active" : ""), title, onclick: onClick }, [label]);
}

export function tagChips(book, { max = 3 } = {}) {
  const names = (book && book.tags) || [];
  const row = el("div", { class: "chips" });
  for (const n of names.slice(0, max)) row.appendChild(el("span", { class: "chip tag", text: n }));
  return row;
}

export function emptyState({ iconName = "library", title = "", text = "", actionLabel = null, onAction = null } = {}) {
  const node = el("div", { class: "empty" }, [
    el("div", { class: "empty-icon", html: icon(iconName, { size: 28 }) }),
    el("h3", { text: title }),
    el("p", { text: text }),
  ]);
  if (actionLabel) node.appendChild(el("button", { class: "btn btn-primary", onclick: onAction }, [actionLabel]));
  return node;
}

export function spinnerNode(size = 18) {
  return el("span", { class: "spinner" + (size > 24 ? " lg" : "") });
}

export function spinnerButton(label, opts = {}) {
  const { className = "btn btn-primary" } = opts;
  const btn = el("button", { class: className, disabled: true }, [el("span", { class: "spinner" }), label]);
  btn._setLabel = (text) => { btn.lastChild.textContent = text; };
  return btn;
}
