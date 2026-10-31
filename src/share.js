// ===========================================================================
// share.js — uploading, AI catalogue metadata, cover art, NSFW verification,
// and the self-contained share-link payload.
//
// KEY DESIGN: we never upload audio. An audiobook is fully determined by
// (text + voice), so we upload the TEXT once and every listener regenerates the
// audio locally. That keeps uploads tiny, the server state tiny, and means a
// share link keeps working forever even after the server drops its listing.
// ===========================================================================

import { FLAG, tagBitsFromNames, tagNamesFromBits, TAGS, MAX_BLURB, MAX_TITLE, MAX_AUTHOR, MAX_TAGS_PER_BOOK, SHARE_PAYLOAD_VERSION, resolveVoice } from "./config.js";
import { contentHash, utf8Bytes, wordCount } from "./util.js";

// --- uploading --------------------------------------------------------------
export async function uploadText(text) {
  const res = await root.uploadPlugin(new Blob([text], { type: "text/plain" }));
  if (res.error) throw new Error(res.error);
  return res;
}
export async function uploadBlob(blob) {
  const res = await root.uploadPlugin(blob);
  if (res.error) throw new Error(res.error);
  return res;
}

export async function fetchText(url, { timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// --- NSFW / moderation ------------------------------------------------------
// Verified at VIEW time from the actual hosted file, so a tampered client
// cannot get unsafe content past the filter.
export async function checkNsfw(url) {
  if (!url) return null;
  try {
    const host = new URL(url).host;
    if (host.endsWith("aigc.uploads.dev")) {
      const info = await fetch(`https://image-generation.perchance.org/api/imageTags?url=${encodeURIComponent(url)}`).then((r) => r.json());
      if (info && info.error) return null;
      return !!(info && info.tags && info.tags.includes("nsfw"));
    }
    const info = await fetch(`https://upload.perchance.org/api/fileInfo?url=${encodeURIComponent(url)}`).then((r) => r.json());
    if (!info || !info.tags) return null;
    return info.tags.includes("nsfw");
  } catch (e) {
    return null;
  }
}

// --- AI catalogue metadata --------------------------------------------------
const TAG_LIST = TAGS.join(", ");

function sampleText(text, max = 4000) {
  text = String(text || "");
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.55));
  const mid = text.slice(Math.floor(text.length / 2), Math.floor(text.length / 2) + Math.floor(max * 0.2));
  const tail = text.slice(-Math.floor(max * 0.25));
  return `${head}\n[...]\n${mid}\n[...]\n${tail}`;
}

export async function generateMetadata(text, { onProgress } = {}) {
  const instruction = `You catalogue texts for an audiobook library. Read the excerpt and output catalogue metadata as ONE compact JSON object, nothing else.

Required JSON keys:
- "title": short engaging title, max 60 characters (use the work's own title if the excerpt clearly states one).
- "author": the author's name if clearly identifiable, otherwise "".
- "blurb": a spoiler-free description of the work, up to ${MAX_BLURB} characters (one or two short paragraphs).
- "tags": array of 1-${MAX_TAGS_PER_BOOK} values, chosen ONLY from this list: ${TAG_LIST}.
- "cover": a visual description for cover art, max 110 characters, no text in the image.

<excerpt>
${sampleText(text)}
</excerpt>

TASK: Return the JSON object now.`;
  const result = await root.generateText({
    instruction,
    startWith: "{",
    stopSequences: ["}"],
    onChunk: onProgress,
  });
  const raw = String(result.text || "");
  let parsed = null;
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { parsed = JSON.parse(raw.slice(s, e + 1)); } catch (err) { parsed = null; }
  }
  if (!parsed) {
    try { parsed = JSON.parse(raw + "}"); } catch (err) { parsed = null; }
  }
  const meta = parsed || {};
  const tags = [];
  for (const g of Array.isArray(meta.tags) ? meta.tags : []) {
    const match = TAGS.find((x) => x.toLowerCase() === String(g).trim().toLowerCase());
    if (match && !tags.includes(match)) tags.push(match);
    if (tags.length >= MAX_TAGS_PER_BOOK) break;
  }
  return {
    title: utf8Bytes(String(meta.title || "").trim(), MAX_TITLE) || "",
    author: utf8Bytes(String(meta.author || "").trim(), MAX_AUTHOR) || "",
    blurb: utf8Bytes(String(meta.blurb || "").trim(), MAX_BLURB) || "",
    tags,
    coverPrompt: String(meta.cover || "").trim(),
  };
}

// --- listing moderation -----------------------------------------------------
// A best-effort gate run just before a submission reaches the server. It is NOT
// a security boundary (a tampered client can skip it); its job is to keep
// drive-by low-effort spam/trolling out of the public library and to tidy up the
// catalogue fields. We fail OPEN on error so a flaky model never blocks a real
// author.
export async function moderateListing({ title, author, blurb, tags }) {
  const instruction = `You are the submission reviewer for a public audiobook library. You receive the catalogue details a contributor wants to publish. Return ONE compact JSON object, nothing else.

Decide "ok": false ONLY if the submission is clearly spam, trolling, gibberish, advertising/solicitation, hateful or harassing, or not a real written work. Otherwise "ok": true.

When "ok" is true, also clean up the fields:
- "title": a proper short title, max 60 characters.
- "author": the author's name, or "" if unknown.
- "blurb": a clear, spoiler-free description, up to ${MAX_BLURB} characters. Fix spelling/grammar; never add facts that aren't implied by the details.
- "tags": 1-${MAX_TAGS_PER_BOOK} values chosen ONLY from this list (add, remove or reorder so the tags genuinely fit): ${TAG_LIST}.
When "ok" is false, set "reason" to a short, user-facing explanation (max 140 characters).

Details submitted:
title: ${JSON.stringify(String(title || ""))}
author: ${JSON.stringify(String(author || ""))}
blurb: ${JSON.stringify(String(blurb || ""))}
tags: ${JSON.stringify(Array.isArray(tags) ? tags : [])}

TASK: Return the JSON object now.`;
  let parsed = null;
  try {
    const result = await root.generateText({ instruction, startWith: "{", stopSequences: ["}"] });
    const raw = String(result.text || "");
    let s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) { try { parsed = JSON.parse(raw.slice(s, e + 1)); } catch (err) { parsed = null; } }
    if (!parsed) { try { parsed = JSON.parse(raw + "}"); } catch (err) { parsed = null; } }
  } catch (e) {
    parsed = null;
  }
  if (!parsed) return { ok: true, failed: true };
  if (parsed.ok === false) {
    return { ok: false, reason: String(parsed.reason || "").trim() || "This submission doesn't meet the library's guidelines." };
  }
  const cleanTags = [];
  for (const g of Array.isArray(parsed.tags) ? parsed.tags : []) {
    const match = TAGS.find((x) => x.toLowerCase() === String(g).trim().toLowerCase());
    if (match && !cleanTags.includes(match)) cleanTags.push(match);
    if (cleanTags.length >= MAX_TAGS_PER_BOOK) break;
  }
  return {
    ok: true,
    title: utf8Bytes(String(parsed.title || title || "").trim(), MAX_TITLE) || String(title || "").trim(),
    author: utf8Bytes(String(parsed.author != null ? parsed.author : (author || "")).trim(), MAX_AUTHOR),
    blurb: utf8Bytes(String(parsed.blurb || blurb || "").trim(), MAX_BLURB),
    tags: cleanTags.length ? cleanTags : (Array.isArray(tags) ? tags : []).slice(0, MAX_TAGS_PER_BOOK),
  };
}

// --- AI title ---------------------------------------------------------------
// Used when a book is created without a title: the first suitable line is used
// immediately as a provisional title, then this replaces it in the background.
export async function generateTitle(text, { onProgress } = {}) {
  const instruction = `You name texts in an audiobook library. Give the text below a short, engaging title of at most 60 characters. If the excerpt clearly states the work's own title, use that. Output ONLY the title — no quotation marks, no trailing punctuation, no explanation.

<excerpt>
${sampleText(text, 3000)}
</excerpt>

TITLE:`;
  const result = await root.generateText({
    instruction,
    startWith: "",
    stopSequences: ["\n"],
    onChunk: onProgress,
  });
  const title = String(result.text || "")
    .replace(/^\s*(title\s*[:\-]\s*)/i, "")
    .replace(/["'“”‘’]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:!\-–—\s]+$/, "")
    .trim();
  return title.length > 1 ? title.slice(0, 60) : "";
}

// --- cover art --------------------------------------------------------------
export async function generateCover(meta, { onProgress } = {}) {
  const parts = [meta.coverPrompt, meta.title, (meta.tags || []).join(", "), "audiobook cover art, cinematic lighting, rich color, highly detailed, no text, no words, no letters"];
  const prompt = parts.filter(Boolean).join(", ").slice(0, 400);
  const result = await root.generateImage({
    prompt,
    negativePrompt: "text, words, letters, watermark, signature, blurry, low quality, deformed",
    resolution: "768x512",
  });
  // result.dataUrl is a data: URL; convert to a Blob for uploading.
  const blob = await (await fetch(result.dataUrl)).blob();
  return { blob, dataUrl: result.dataUrl, prompt };
}

// --- share payload ----------------------------------------------------------
// A share link carries only a short upload id in the query string (`?b=<id>`).
// The metadata itself lives in a tiny uploaded .json file, so the link stays
// compact and keeps working even after the book leaves Explore. The query (not
// a hash) is what lets `$meta.dynamic` in main.pjs read the id server-side and
// give social-media previews the right title + cover art.
export const UPLOAD_FILE_BASE = "https://user.uploads.dev/file/";

export function bookToShareMeta(book) {
  return {
    v: SHARE_PAYLOAD_VERSION,
    t: book.title || "",
    a: book.author || "",
    b: book.blurb || "",
    u: book.textUrl || "",
    c: book.coverUrl || "",
    o: book.voice || "",
    g: book.tagBits || tagBitsFromNames(book.tags || []),
    w: book.wordCount | 0,
  };
}

export async function publishShareMeta(book) {
  const blob = new Blob([JSON.stringify(bookToShareMeta(book))], { type: "application/json" });
  const res = await root.uploadPlugin(blob);
  if (res.error) throw new Error(res.error);
  const id = String(res.url).split("/").pop();
  return { id, url: res.url };
}

export function shareUrlFor(id) {
  return `https://perchance.org/${window.generatorName}?b=${String(id).replace(/\.json$/i, "")}`;
}

function bookFromMeta(d, id) {
  if (!d || !d.u) return null;
  const tagBits = /^[0-9a-f]{64}$/i.test(d.g || "") ? String(d.g).toLowerCase() : "0".repeat(64);
  return {
    id: "shared:" + (id || (contentHash(d.u).a >>> 0).toString(36)),
    seq: null,
    title: d.t || "Untitled",
    author: d.a || "",
    blurb: d.b || "",
    textUrl: d.u,
    coverUrl: d.c || "",
    voice: d.o || "af_heart",
    tagBits,
    tags: tagNamesFromBits(tagBits),
    nsfw: false,
    wordCount: d.w | 0,
    createdAt: Date.now(),
    origin: "shared",
  };
}

export async function resolveSharePayload(payload) {
  const id = String(payload || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  // The share link omits the .json extension for brevity; the upload itself is
  // a JSON file, so fetch it with the extension.
  try {
    const res = await fetch(UPLOAD_FILE_BASE + id + ".json");
    if (!res.ok) return null;
    const d = await res.json();
    return bookFromMeta(d, id);
  } catch (e) {
    return null;
  }
}

// --- server listing bundle --------------------------------------------------
// The Explore slot stores only the small, numeric metadata the server needs to
// search/sort/rank, plus title/author. Everything bulky that a listing needs to
// *display* or *play* is bundled into a tiny uploaded `.json` file; the slot
// keeps just the bundle's 32-hex upload id. Fetching one bundle per listing is
// cheap (`user.uploads.dev` is immutable + CDN-cached), so the feed hydrates
// lazily.
export const BUNDLE_VERSION = 2;

export function bundleUrlFor(id) {
  return UPLOAD_FILE_BASE + String(id).replace(/\.json$/i, "") + ".json";
}

export function bookToBundle(book, voiceId) {
  return {
    v: BUNDLE_VERSION,
    t: book.title || "",
    a: book.author || "",
    b: book.blurb || "",
    u: book.textUrl || "",
    c: book.coverUrl || "",
    o: voiceId || book.voice || "",
  };
}

export async function publishBundle(book, voiceId) {
  const blob = new Blob([JSON.stringify(bookToBundle(book, voiceId))], { type: "application/json" });
  const res = await root.uploadPlugin(blob);
  if (res.error) throw new Error(res.error);
  const id = String(res.url).split("/").pop().replace(/\.json$/i, "");
  return { id, url: res.url };
}

const bundleCache = new Map();

export async function fetchBundle(id) {
  const key = String(id || "").replace(/\.json$/i, "");
  if (!key) return null;
  if (bundleCache.has(key)) return bundleCache.get(key);
  const promise = (async () => {
    try {
      const res = await fetch(bundleUrlFor(key), { cache: "force-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const d = await res.json();
      return d && typeof d === "object" ? d : null;
    } catch (e) {
      return null;
    }
  })();
  bundleCache.set(key, promise);
  const out = await promise;
  if (!out) bundleCache.delete(key); // allow a later retry
  return out;
}

// Fold an uploaded bundle's display/playback fields onto a listing row.
export function applyBundle(book, bundle) {
  if (!book || !bundle) return book;
  if (bundle.t) book.title = bundle.t;
  if (bundle.a != null) book.author = bundle.a;
  if (bundle.b) book.blurb = bundle.b;
  if (bundle.u) book.textUrl = bundle.u;
  if (bundle.c) book.coverUrl = bundle.c;
  book.voice = resolveVoice(bundle.o) || "af_heart";
  return book;
}

// Make sure a listing row has its display/playback fields before we use it
// (e.g. the user opens a card before the feed finished hydrating).
export async function ensureBundle(book) {
  if (!book || book._hydrated || !book.bundleId) return book;
  try { applyBundle(book, await fetchBundle(book.bundleId)); } catch (e) {}
  book._hydrated = true;
  return book;
}

// Build a server-bound record from a local/shared book.
export function buildServerRecord(book, text, bundleId) {
  const h = contentHash(text);
  let flags = 0;
  if (book.coverUrl || book.coverLocal) flags |= FLAG.CUSTOM_COVER;
  flags |= FLAG.AI_TAGS;
  return {
    hashA: h.a, hashB: h.b,
    bundleId,
    title: utf8Bytes(book.title || "Untitled", MAX_TITLE),
    author: utf8Bytes(book.author || "", MAX_AUTHOR),
    tagBits: book.tagBits || tagBitsFromNames(book.tags || []),
    wordCount: book.wordCount || wordCount(text),
    flags,
  };
}
