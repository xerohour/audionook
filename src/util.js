// ===========================================================================
// util.js — small, dependency-free helpers used across the app.
// ===========================================================================

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function toNode(c) {
  if (c == null || c === false) return null;
  if (c.nodeType) return c;
  if (typeof c === "string" && /^\s*</.test(c)) {
    // A markup-looking string (e.g. an inline SVG from icon()) is parsed as
    // HTML. Plain labels/text always go through the `text` prop or are plain
    // strings that don't start with "<".
    const tpl = document.createElement("template");
    tpl.innerHTML = c.trim();
    if (tpl.content.childNodes.length === 1) return tpl.content.firstChild;
    const frag = document.createDocumentFragment();
    frag.append(tpl.content);
    return frag;
  }
  return document.createTextNode(String(c));
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    const n = toNode(c);
    if (n) node.append(n);
  }
  return node;
}

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// --- hashing / encoding ----------------------------------------------------
export function fnv1a(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
// two independent-ish 32-bit hashes => a 64-bit content fingerprint
export function contentHash(str) {
  return { a: fnv1a(str, 0x811c9dc5), b: fnv1a(str, 0x1b873593) };
}
// The same fingerprint over raw bytes (used to compare cover-image blobs without
// keeping a copy of them around). `contentHash` hashes UTF-16 code units, so it
// can't be reused for binary.
export function contentHashBytes(bytes) {
  let a = 0x811c9dc5, b = 0x1b873593;
  for (let i = 0; i < bytes.length; i++) {
    const x = bytes[i];
    a ^= x; a = Math.imul(a, 0x01000193) >>> 0;
    b = (b + x) >>> 0; b = Math.imul(b ^ (b >>> 15), 0x85ebca6b) >>> 0;
  }
  return { a: a >>> 0, b: b >>> 0 };
}

// --- text -------------------------------------------------------------------
export function utf8Bytes(str, max) {
  // Truncate a string to at most `max` UTF-8 bytes without splitting a code point.
  const enc = new TextEncoder();
  let bytes = enc.encode(str);
  if (bytes.length <= max) return str;
  let s = str;
  while (enc.encode(s).length > max) s = s.slice(0, -1);
  return s;
}
export function truncate(str, chars) {
  str = String(str == null ? "" : str);
  return str.length > chars ? str.slice(0, chars - 1).trimEnd() + "…" : str;
}
export function wordCount(str) {
  const m = String(str || "").trim().match(/\S+/g);
  return m ? m.length : 0;
}

// --- formatting -------------------------------------------------------------
export function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
export function formatLongDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}
export function formatCompact(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "") + "K";
  return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
}
export function timeAgo(ts) {
  const s = Math.max(1, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d ago`;
  const mo = d / 30;
  if (mo < 12) return `${Math.floor(mo)}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// --- timing -----------------------------------------------------------------
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- misc -------------------------------------------------------------------
export function uid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e2) { return false; }
  }
}

// --- procedural covers ------------------------------------------------------
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic, instantly-computed CSS cover art from a seed string.
export function coverStyle(seed, baseHue = null) {
  const h = fnv1a(String(seed || "x"));
  const r = mulberry32(h);
  const hue = baseHue == null ? Math.floor(r() * 360) : (baseHue + Math.floor(r() * 32) - 16 + 360) % 360;
  const hue2 = (hue + 40 + Math.floor(r() * 90)) % 360;
  const hue3 = (hue + 300 + Math.floor(r() * 80)) % 360;
  const x1 = Math.floor(r() * 80) + 10, y1 = Math.floor(r() * 80) + 10;
  const x2 = Math.floor(r() * 80) + 10, y2 = Math.floor(r() * 80) + 10;
  const ang = Math.floor(r() * 360);
  return [
    `linear-gradient(180deg, rgba(3,5,10,.52), rgba(3,5,10,.06) 30%, rgba(3,5,10,.14) 58%, rgba(3,5,10,.74))`,
    `radial-gradient(circle at ${x1}% ${y1}%, hsl(${hue2} 68% 46% / .5), transparent 56%)`,
    `radial-gradient(circle at ${x2}% ${y2}%, hsl(${hue3} 62% 42% / .42), transparent 60%)`,
    `linear-gradient(${ang}deg, hsl(${hue} 55% 22%), hsl(${(hue + 25) % 360} 62% 10%))`,
  ].join(", ");
}
export function coverInitial(seed) {
  const s = String(seed || "").trim();
  return s ? s[0].toUpperCase() : "A";
}

// Canvas version (for MediaSession artwork, share images, etc.).
export function coverDataUrl(seed, size = 512, initial) {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  const h = fnv1a(String(seed || "x"));
  const r = mulberry32(h);
  const hue = Math.floor(r() * 360);
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, `hsl(${hue} 62% 26%)`);
  g.addColorStop(1, `hsl(${(hue + 25) % 360} 70% 11%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 5; i++) {
    const x = r() * size, y = r() * size, rad = size * (0.25 + r() * 0.5);
    const rg = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const hh = (hue + Math.floor(r() * 140 - 70) + 360) % 360;
    rg.addColorStop(0, `hsla(${hh} 78% 60% / ${0.3 + r() * 0.3})`);
    rg.addColorStop(1, `hsla(${hh} 78% 60% / 0)`);
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
  }
  if (initial) {
    ctx.fillStyle = "rgba(255,255,255,.9)";
    ctx.font = `600 ${size * 0.44}px Georgia, 'Times New Roman', serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(initial).slice(0, 1).toUpperCase(), size / 2, size / 2 + size * 0.03);
  }
  return c.toDataURL("image/jpeg", 0.82);
}

// --- icons (inline SVG) -----------------------------------------------------
const SKIP_TEXT = "stroke=\"none\" font-family=\"Inter, sans-serif\" font-weight=\"700\" text-anchor=\"middle\" fill=\"currentColor\"";
const P = {
  play: '<path d="M8 7.7Q8 5.5 9.89 6.62L17.11 10.88Q19 12 17.11 13.12L9.89 17.38Q8 18.5 8 16.3Z"/>',
  pause: '<rect x="6.9" y="5" width="3.5" height="14" rx="1.4"/><rect x="13.6" y="5" width="3.5" height="14" rx="1.4"/>',
  back15: '<path d="M11.5 8V5.2L7.7 8.4l3.8 3.2V9a4.6 4.6 0 1 1-4.5 5.3H5a6.5 6.5 0 1 0 6.5-6.3z"/><text x="12" y="16" font-size="7" ' + SKIP_TEXT + '>15</text>',
  fwd15: '<path d="M12.5 8V5.2l3.8 3.2-3.8 3.2V9a4.6 4.6 0 1 0 4.5 5.3H19a6.5 6.5 0 1 1-6.5-6.3z"/><text x="12" y="16" font-size="7" ' + SKIP_TEXT + '>15</text>',
  // The back/forward arc is one continuous circle with the arrowhead tucked into
  // the small gap at the top, and the number centred inside the loop.
  back10: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 3v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="14.7" font-size="7.6" ' + SKIP_TEXT + '>10</text>',
  fwd30: '<path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 3v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="14.7" font-size="7.6" ' + SKIP_TEXT + '>30</text>',
  chevronRight: '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  search: '<circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  compass: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor"/>',
  library: '<path d="M4 5h2.5v14H4zM9 5h2.5v14H9zM14 6l2.4-.6 3.3 12.6-2.4.6z"/>',
  plus: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  share: '<circle cx="6.2" cy="12" r="2.7"/><circle cx="17.4" cy="5.8" r="2.7"/><circle cx="17.4" cy="18.2" r="2.7"/><path d="M8.6 10.6l6.4-3.4M8.6 13.4l6.4 3.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  download: '<path d="M11 3h2v8h3.5L12 17l-4.5-6H11z"/><path d="M5 19h14v2H5z"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  globe: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronDown: '<path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  trash: '<path d="M6 7h12M9 7V5h6v2M8 7l1 13h6l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  sliders: '<path d="M5 7h8.5M19 7h-.5M5 17h.5M11 17h8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="16" cy="7" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="17" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  info: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.2"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.3A4.2 4.2 0 0 1 12 7.7a4.2 4.2 0 0 1 7 3c0 4.9-7 9.3-7 9.3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  headphone: '<path d="M5 13v-1a7 7 0 0 1 14 0v1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3.2" y="13" width="4" height="7" rx="1.6"/><rect x="16.8" y="13" width="4" height="7" rx="1.6"/>',
  clock: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3.5 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  text: '<path d="M4 5h16v2.2H13.2V19h-2.4V7.2H4z"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l5-5 3.5 3.5L17 12l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  play2: '<path d="M6 4l14 8-14 8z"/>',
  pencil: '<path d="M4 20h4.2L19.4 8.8a2.1 2.1 0 0 0 0-3l-1.2-1.2a2.1 2.1 0 0 0-3 0L4 15.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.6 6.4l4 4" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  folder: '<path d="M3.6 7.1c0-1.1.9-2 2-2h3.1c.6 0 1.1.2 1.5.6l1.1 1.2h7.1c1.1 0 2 .9 2 2v8.4c0 1.1-.9 2-2 2H5.6c-1.1 0-2-.9-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  folderPlus: '<path d="M3.6 7.1c0-1.1.9-2 2-2h3.1c.6 0 1.1.2 1.5.6l1.1 1.2h7.1c1.1 0 2 .9 2 2v8.4c0 1.1-.9 2-2 2H5.6c-1.1 0-2-.9-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 11.5v5M9.5 14h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  archive: '<rect x="3.5" y="4.6" width="17" height="4.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.3 8.8V19a1 1 0 0 0 1 1h11.4a1 1 0 0 0 1-1V8.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 12.4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  unarchive: '<rect x="3.5" y="4.6" width="17" height="4.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.3 8.8V19a1 1 0 0 0 1 1h11.4a1 1 0 0 0 1-1V8.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 16.2v-5M9.8 13.2L12 11l2.2 2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  upload: '<path d="M12 16V4M8 8l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15v3.4A1.6 1.6 0 0 0 5.6 20h12.8a1.6 1.6 0 0 0 1.6-1.6V15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  link: '<path d="M10.2 13.6a4.1 4.1 0 0 0 5.8 0l2.4-2.4a4.1 4.1 0 1 0-5.8-5.8l-1.1 1.1" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M13.8 10.4a4.1 4.1 0 0 0-5.8 0l-2.4 2.4a4.1 4.1 0 1 0 5.8 5.8l1.1-1.1" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  fileText: '<path d="M6 3.6h7L18.4 9v11A1.4 1.4 0 0 1 17 21.4H6A1.4 1.4 0 0 1 4.6 20V5A1.4 1.4 0 0 1 6 3.6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12.8 3.6V9h5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 13.2h8M8 16.6h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  move: '<path d="M12 4v16M4 12h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 4l-2.6 2.6M12 4l2.6 2.6M12 20l-2.6-2.6M12 20l2.6-2.6M4 12l2.6-2.6M4 12l2.6 2.6M20 12l-2.6-2.6M20 12l-2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  lock: '<rect x="4.8" y="10.4" width="14.4" height="10.2" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.2 10.4V8a3.8 3.8 0 0 1 7.6 0v2.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  database: '<ellipse cx="12" cy="6" rx="7.2" ry="2.7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.8 6v12c0 1.5 3.2 2.7 7.2 2.7s7.2-1.2 7.2-2.7V6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.8 12c0 1.5 3.2 2.7 7.2 2.7s7.2-1.2 7.2-2.7" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  headphones: '<path d="M4.6 15.6v-3a7.4 7.4 0 0 1 14.8 0v3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><rect x="3" y="14.2" width="3.6" height="6.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.9"/><rect x="17.4" y="14.2" width="3.6" height="6.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.9"/>',
  bookmark: '<path d="M6.6 5.4A1.4 1.4 0 0 1 8 4h8a1.4 1.4 0 0 1 1.4 1.4v14.2L12 15.7 6.6 19.6z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
  bookmarkFill: '<path d="M6.6 5.4A1.4 1.4 0 0 1 8 4h8a1.4 1.4 0 0 1 1.4 1.4v14.2L12 15.7 6.6 19.6z"/>',
  bookmarkPlus: '<path d="M6.6 5.4A1.4 1.4 0 0 1 8 4h8a1.4 1.4 0 0 1 1.4 1.4v14.2L12 15.7 6.6 19.6z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M12 8.6v4.4M9.8 10.8h4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  bookmarkOff: '<path d="M17.4 5.4A1.4 1.4 0 0 0 16 4H8a1.4 1.4 0 0 0-1.4 1.4v14.2L12 15.7l5.4 3.9z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M4.5 4.5l15 15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  list: '<path d="M8 6.5h12M8 12h12M8 17.5h12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="4.3" cy="6.5" r="1.2"/><circle cx="4.3" cy="12" r="1.2"/><circle cx="4.3" cy="17.5" r="1.2"/>',
  up: '<path d="M12 19V6M6.5 11.5L12 6l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M12 5v13M6.5 12.5L12 18l5.5-5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  tag: '<path d="M12.6 3.6H19a1.4 1.4 0 0 1 1.4 1.4v6.4a1.4 1.4 0 0 1-.41.99l-7.6 7.6a1.4 1.4 0 0 1-1.98 0l-6.4-6.4a1.4 1.4 0 0 1 0-1.98l7.6-7.6a1.4 1.4 0 0 1 .99-.41z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="16.1" cy="7.9" r="1.35"/>',
  readMarker: '<rect x="4.2" y="3.7" width="15.6" height="16.6" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="15.3" cy="8.2" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  unreadMarker: '<rect x="4.2" y="3.7" width="15.6" height="16.6" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="15.3" cy="8.2" r="2.5" fill="currentColor"/>',
  moreCircle: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.2" cy="12" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="15.8" cy="12" r="1.25"/>',
  filter: '<path d="M4 5.5h16l-6.2 7.2v5.4l-3.6-2v-3.4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  locate: '<circle cx="12" cy="12" r="6.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/><path d="M12 2.6v2.8M12 18.6v2.8M2.6 12h2.8M18.6 12h2.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  playAll: '<path d="M5 4.4v15.2l12.2-7.6z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M19.4 4.6v14.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  sync: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 3v5h-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 16H3v5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
};
export function icon(name, { size = 20, cls = "icon" } = {}) {
  const body = P[name] || "";
  return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${body}</svg>`;
}

// The Audionook mark: a wide bookmark ribbon holding a damped sound wave
// (a sine that decays left to right). Line-art so it reads at ~18px in the top
// bar and at favicon sizes. Kept as one source of truth for mark + favicon.
const BRAND_RIBBON = `M6.7 3.6h10.6v16.6l-5.3-3.6-5.3 3.6z`;
const BRAND_WAVE = `M8.5 11.6q.9-3 1.8 0q.9 2.5 1.8 0q.8-1.9 1.5 0q.6 1.2 1.1 0q.4-.7.8 0`;
export function brandMarkSvg({ size = 20, cls = "brand-svg" } = {}) {
  return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="${BRAND_RIBBON}"/>` +
    `<path d="${BRAND_WAVE}"/>` +
    `</svg>`;
}

// Self-contained SVG (amber tile + ink mark) used as the favicon.
export function brandFaviconDataUrl() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<rect width="24" height="24" rx="5.4" fill="#f0a63c"/>` +
    `<g fill="none" stroke="#231604" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${BRAND_RIBBON}"/>` +
    `<path d="${BRAND_WAVE}"/>` +
    `</g></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

// --- toasts -----------------------------------------------------------------
export function toast(message, { type = "info", timeout = 3200 } = {}) {
  const root = $("#toastRoot");
  if (!root) return;
  const node = el("div", { class: `toast toast-${type}` }, [message]);
  root.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 300);
  }, timeout);
  return node;
}

// --- modal ------------------------------------------------------------------
let activeModal = null;
export function openModal({ title, body, actions, className = "", onClose } = {}) {
  closeModal();
  const root = $("#modalRoot");
  const overlay = el("div", { class: "modal-overlay" });
  const panel = el("div", { class: `modal-panel ${className}` });
  const closeBtn = el("button", { class: "icon-btn modal-close", "aria-label": "Close", html: icon("close", { size: 20 }) });
  const cleanup = () => {
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 220);
    document.removeEventListener("keydown", onKey);
    activeModal = null;
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); cleanup(); } };
  closeBtn.addEventListener("click", cleanup);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(); });
  document.addEventListener("keydown", onKey);
  // The header (title + close) is a fixed strip; only the body scrolls, so the
  // close button is always reachable no matter how long the modal content is.
  const head = el("div", { class: "modal-head" + (title ? "" : " no-title") });
  if (title) head.appendChild(el("h2", { class: "modal-title", text: title }));
  head.appendChild(closeBtn);
  panel.appendChild(head);
  const bodyEl = el("div", { class: "modal-body" });
  if (body && body.nodeType) bodyEl.appendChild(body);
  else if (typeof body === "string") bodyEl.innerHTML = body;
  panel.appendChild(bodyEl);
  if (actions && actions.length) {
    const bar = el("div", { class: "modal-actions" });
    for (const a of actions) {
      bar.appendChild(el("button", { class: `btn ${a.class || "btn-ghost"}`, onclick: a.onClick, text: a.label }));
    }
    panel.appendChild(bar);
  }
  overlay.appendChild(panel);
  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("open"));
  activeModal = { overlay, panel, close: cleanup };
  return activeModal;
}
export function closeModal() {
  if (activeModal) activeModal.close();
}
export function isModalOpen() { return !!activeModal; }

// --- context menu -----------------------------------------------------------
// A compact popup used for right-click (desktop) and long-press (touch). Items:
// { icon, label, hint, danger, disabled, separator, onClick }.
let activeMenu = null;
export function closeContextMenu() {
  if (!activeMenu) return;
  const { node, cleanup } = activeMenu;
  activeMenu = null;
  cleanup();
  node.classList.remove("open");
  setTimeout(() => node.remove(), 150);
}
export function isContextMenuOpen() { return !!activeMenu; }
export function openContextMenu(items, { x = 0, y = 0 } = {}) {
  closeContextMenu();
  if (!items || !items.length) return null;
  const menu = el("div", { class: "ctx-menu", role: "menu" });
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { menu.appendChild(el("div", { class: "ctx-sep" })); continue; }
    const row = el("button", {
      class: "ctx-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : ""),
      role: "menuitem", disabled: !!it.disabled, title: it.hint || "",
    });
    row.appendChild(el("span", { class: "ctx-ic", html: it.icon ? icon(it.icon, { size: 16 }) : "" }));
    row.appendChild(el("span", { class: "ctx-label", text: it.label }));
    if (it.hint) row.appendChild(el("span", { class: "ctx-hint", text: it.hint }));
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      closeContextMenu();
      if (it.onClick) it.onClick();
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const pad = 10;
  const place = () => {
    // Measure at full scale (the entry animation scales the menu down, which
    // would otherwise let it spill a few pixels past the viewport edge). Use the
    // client box so the menu never hides beneath a classic scrollbar.
    const width = menu.offsetWidth, height = menu.offsetHeight;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    let left = x, top = y;
    if (left + width + pad > vw) left = vw - width - pad;
    if (top + height + pad > vh) top = vh - height - pad;
    menu.style.left = Math.max(pad, left) + "px";
    menu.style.top = Math.max(pad, top) + "px";
  };
  place();
  requestAnimationFrame(() => menu.classList.add("open"));
  const onDown = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeContextMenu(); } };
  const onDismiss = () => closeContextMenu();
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onDismiss, true);
  window.addEventListener("resize", onDismiss);
  const cleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onDismiss, true);
    window.removeEventListener("resize", onDismiss);
  };
  activeMenu = { node: menu, cleanup };
  return menu;
}
