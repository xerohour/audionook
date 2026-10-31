// ===========================================================================
// import.js — turn an uploaded document into plain text for narration.
//
// Every heavy parser is loaded lazily, and only when a file of that type is
// actually opened, so a visitor who pastes text never downloads pdf.js /
// mammoth / zip.js. Supported: .txt, .md, .markdown, .html, .rtf, .pdf, .docx,
// .epub, .odt.
// ===========================================================================

export const ACCEPT = [
  ".txt", ".text", ".md", ".markdown", ".html", ".htm", ".xhtml", ".rtf",
  ".pdf", ".docx", ".epub", ".odt", "text/plain",
].join(",");

export const MAX_FILE_BYTES = 48 * 1024 * 1024;

const ZIP_URL = "https://esm.sh/@zip.js/zip.js@2.7.52";
let zipMod = null;
async function zipLib() {
  if (!zipMod) {
    zipMod = await import(ZIP_URL);
    try { zipMod.configure({ useWebWorkers: false, useCompressionStream: true }); } catch (e) {}
  }
  return zipMod;
}

const extOf = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
};

// Returns { text, title }. `title` may be "" when the document doesn't declare
// one; the caller can fall back to the first line.
export async function fileToText(file, { onProgress } = {}) {
  const name = file.name || "";
  const ext = extOf(name);
  const say = (s) => { if (onProgress) onProgress(s); };
  let text = "";
  let title = "";
  if (ext === "pdf") { say("Reading PDF…"); ({ text, title } = await parsePdf(file, say)); }
  else if (ext === "docx") { say("Reading Word document…"); text = await parseDocx(file); }
  else if (ext === "epub") { say("Reading EPUB…"); ({ text, title } = await parseEpub(file, say)); }
  else if (ext === "odt") { say("Reading OpenDocument…"); text = await parseOdt(file); }
  else if (ext === "html" || ext === "htm" || ext === "xhtml") { say("Reading page…"); ({ text, title } = parseMarkup(await file.text())); }
  else if (ext === "rtf") { say("Reading RTF…"); text = parseRtf(await file.text()); }
  else if (ext === "md" || ext === "markdown") { say("Reading markdown…"); ({ text, title } = parseMarkdown(await file.text())); }
  else { say("Reading file…"); text = await file.text(); }

  text = cleanText(text);
  if (looksBinary(text) && wordCount(text) < 5) throw new Error("that file doesn't contain readable text");
  if (!title) title = firstLineTitle(text);
  return { text, title };
}

function wordCount(s) { const m = String(s || "").trim().match(/\S+/g); return m ? m.length : 0; }

function cleanText(s) {
  return String(s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksBinary(s) {
  if (!s) return false;
  let bad = 0;
  for (let i = 0; i < Math.min(s.length, 4000); i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd || (c < 9 && c !== 0) || (c > 13 && c < 32)) bad++;
  }
  return bad > Math.min(s.length, 4000) * 0.08;
}

function firstLineTitle(text) {
  const line = String(text || "").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length > 1 && l.length <= 80);
  return line || "";
}

function firstTagText(src, re) {
  const m = re.exec(String(src || ""));
  if (!m) return "";
  return m[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10))).trim();
}

// --- markup (html/xhtml) ----------------------------------------------------
export function parseMarkup(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  doc.querySelectorAll("script, style, nav, header, footer, aside, noscript, form, iframe, svg, template").forEach((n) => n.remove());
  const title = (doc.title || "").trim();
  const main = doc.querySelector("article") || doc.querySelector("main") || doc.body;
  const blocks = [];
  if (main) {
    for (const node of main.querySelectorAll("h1, h2, h3, h4, p, li, blockquote, pre, div")) {
      if (node.querySelector("p, li, blockquote, h1, h2, h3, h4")) continue;
      const t = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (t) blocks.push(t);
    }
  }
  let text = blocks.join("\n\n");
  if (wordCount(text) < 8 && main) text = (main.textContent || "").trim();
  return { text, title: title && wordCount(title) < 20 ? title : "" };
}

// --- markdown ---------------------------------------------------------------
export function parseMarkdown(src) {
  let s = String(src || "");
  let title = "";
  const fm = /^---\n[\s\S]*?\n---\n/.exec(s);
  if (fm) {
    const t = /^title:\s*(.+)$/m.exec(fm[0]);
    if (t) title = t[1].replace(/^["']|["']$/g, "").trim();
    s = s.slice(fm[0].length);
  }
  s = s
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}([*+-]|\d+[.)])\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^\s*([-*_]\s*){3,}$/gm, "")
    .replace(/^\|.*\|$/gm, (row) => row.split("|").filter((c) => c.trim() !== "").join(" · ").replace(/^ · /, ""))
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "")
    .replace(/<[^>]+>/g, "");
  const firstLine = s.split("\n").map((l) => l.trim()).find((l) => l.length > 1 && l.length <= 80);
  if (!title && firstLine) title = firstLine.length > 1 ? firstLine : "";
  return { text: s, title };
}

// --- rtf (best-effort) ------------------------------------------------------
const RTF_SKIP = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata",
  "colorschememapping", "latentstyles", "datastore", "header", "headerl",
  "headerr", "headerf", "footer", "footerl", "footerr", "footerf",
  "footnote", "fldinst", "datafield", "listtable", "listoverridetable",
  "rsidtbl", "generator", "filetbl", "revtbl", "xmlnstbl", "upr",
]);

function parseRtf(src) {
  const s = String(src || "");
  let out = "";
  let depth = 0;
  let skipUntil = -1; // depth to return to after skipping an ignored group
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === "{") {
      depth++;
      // {\*\...} destination groups are always ignorable.
      if (skipUntil < 0 && s[i + 1] === "\\" && s[i + 2] === "*") { skipUntil = depth - 1; depth--; }
      i++;
      continue;
    }
    if (ch === "}") {
      if (skipUntil >= 0 && depth - 1 <= skipUntil) skipUntil = -1;
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (skipUntil >= 0) { i++; continue; }
    if (ch === "\\") {
      const rest = s.slice(i);
      let m;
      if ((m = /^\\'([0-9a-f]{2})/i.exec(rest))) {
        out += cp1252(parseInt(m[1], 16));
        i += m[0].length;
      } else if ((m = /^\\u(-?\d+)\s?\??/.exec(rest))) {
        let code = parseInt(m[1], 10); if (code < 0) code += 65536;
        out += String.fromCharCode(code);
        i += m[0].length;
      } else if ((m = /^\\(par|line|pard|sect|page)\b\s?/.exec(rest))) {
        out += m[1] === "line" ? "\n" : "\n\n";
        i += m[0].length;
      } else if ((m = /^\\tab\b\s?/.exec(rest))) {
        out += "\t";
        i += m[0].length;
      } else if ((m = /^\\([a-z]+)(-?\d+)?\s?/i.exec(rest))) {
        const word = m[1].toLowerCase();
        if (depth > 0 && skipUntil < 0 && RTF_SKIP.has(word)) { skipUntil = depth - 1; }
        i += m[0].length;
        if (word === "emdash") out += "—";
        else if (word === "endash") out += "–";
        else if (word === "bullet") out += "•";
        else if (word === "lquote") out += "‘";
        else if (word === "rquote") out += "’";
        else if (word === "ldblquote") out += "“";
        else if (word === "rdblquote") out += "”";
      } else {
        // lone backslash or unhandled control symbol
        if (/^\\[^a-z]/i.test(rest)) out += rest[1] === "\\" || rest[1] === "{" || rest[1] === "}" ? rest[1] : "";
        i += 2;
      }
      continue;
    }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { i++; continue; }
    out += ch;
    i++;
  }
  return out;
}

function cp1252(b) {
  if (b >= 0x80 && b <= 0x9f) {
    const map = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";
    return map[b - 0x80];
  }
  return String.fromCharCode(b);
}

// --- pdf --------------------------------------------------------------------
const PDFJS_VERSION = "4.6.82";
let pdfjsMod = null;
async function getPdfjs() {
  if (!pdfjsMod) {
    const pdfjs = await import(`https://esm.sh/pdfjs-dist@${PDFJS_VERSION}/build/pdf.mjs`);
    try {
      // A cross-origin worker URL can't be passed to `new Worker` directly, and
      // esm.sh's worker shim uses root-relative imports that break inside a blob
      // worker — so fetch the self-contained worker bundle and wrap it in a blob.
      const code = await fetch(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`).then((r) => r.text());
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })), { type: "module" });
    } catch (e) {
      console.warn("pdf worker setup failed, parsing on the main thread:", e);
      pdfjs.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.mjs`;
    }
    pdfjsMod = pdfjs;
  }
  return pdfjsMod;
}

async function parsePdf(file, say) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  let title = "";
  try {
    const meta = await doc.getMetadata();
    title = ((meta && meta.info && meta.info.Title) || "").trim();
  } catch (e) {}
  const parts = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (say && (p === 1 || p % 5 === 0)) say(`Reading PDF… page ${p} of ${doc.numPages}`);
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = "";
      const lines = [];
      for (const item of content.items) {
        if (item.str) line += item.str;
        if (item.hasEOL) { lines.push(line.replace(/\s+$/, "")); line = ""; }
        else if (item.str && !/\S$/.test(item.str)) line += " ";
      }
      if (line.trim()) lines.push(line.trim());
      const pageText = joinWrappedLines(lines);
      if (pageText) parts.push(pageText);
      page.cleanup();
    }
  } finally {
    try { doc.destroy(); } catch (e) {}
  }
  return { text: parts.join("\n\n"), title: wordCount(title) < 20 ? title : "" };
}

// PDF text extraction emits one entry per visual line; merge lines that don't
// end a sentence so the narrator reads flowing prose instead of choppy fragments.
function joinWrappedLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const prev = out[out.length - 1];
    if (prev && !/[.!?:;”"')\]]$/.test(prev) && /^[a-z(“"']/.test(line)) out[out.length - 1] = prev + " " + line;
    else out.push(line);
  }
  return out.join("\n");
}

// --- docx -------------------------------------------------------------------
async function parseDocx(file) {
  const mammoth = await import("https://esm.sh/mammoth@1.8.0?bundle");
  const mod = mammoth.default || mammoth;
  const arrayBuffer = await file.arrayBuffer();
  const result = await mod.extractRawText({ arrayBuffer });
  return result && result.value ? result.value : "";
}

// --- shared zip helpers -----------------------------------------------------
async function readZipEntries(file, wanted) {
  const { BlobReader, TextWriter, ZipReader } = await zipLib();
  const reader = new ZipReader(new BlobReader(file));
  const out = new Map();
  try {
    const entries = await reader.getEntries();
    for (const entry of entries) {
      if (entry.directory) continue;
      const path = entry.filename;
      if (wanted && !wanted(path)) continue;
      try { out.set(path, await entry.getData(new TextWriter())); } catch (e) {}
    }
  } finally {
    try { await reader.close(); } catch (e) {}
  }
  return out;
}

function resolvePath(baseDir, href) {
  if (!href) return "";
  if (/^[a-z]+:\/\//i.test(href)) return href;
  const parts = (baseDir ? baseDir.split("/") : []).concat(decodeURIComponent(href.split(/[?#]/)[0]).split("/"));
  const out = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}
const dirName = (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";

// --- epub -------------------------------------------------------------------
async function parseEpub(file, say) {
  const all = await readZipEntries(file, null);
  const container = all.get("META-INF/container.xml") || all.get("meta-inf/container.xml");
  let opfPath = "";
  if (container) {
    const cdoc = new DOMParser().parseFromString(container, "application/xml");
    const rootfile = cdoc.querySelector("rootfile");
    if (rootfile) opfPath = rootfile.getAttribute("full-path") || "";
  }
  if (!opfPath) {
    for (const path of all.keys()) if (/\.opf$/i.test(path)) { opfPath = path; break; }
  }
  if (!opfPath) throw new Error("couldn't find the book's structure");
  const opf = all.get(opfPath);
  const odoc = new DOMParser().parseFromString(opf || "", "application/xml");
  const baseDir = dirName(opfPath);
  const opfTitle = (firstTagText(opf, /<(?:dc:)?title[^>]*>([\s\S]*?)<\//i) || "").trim();
  const manifest = new Map();
  for (const item of odoc.querySelectorAll("manifest > item")) {
    manifest.set(item.getAttribute("id"), {
      href: resolvePath(baseDir, item.getAttribute("href")),
      type: item.getAttribute("media-type") || "",
    });
  }
  const order = [];
  for (const ref of odoc.querySelectorAll("spine > itemref")) {
    const id = ref.getAttribute("idref");
    const item = manifest.get(id);
    if (item && /xhtml|html|xml/i.test(item.type || "")) order.push(item.href);
  }
  if (!order.length) for (const [, it] of manifest) if (/xhtml|html/i.test(it.type || "")) order.push(it.href);

  const parts = [];
  let title = "";
  const total = order.length || 1;
  for (let i = 0; i < order.length; i++) {
    if (say && (i === 0 || i % 4 === 0)) say(`Reading EPUB… section ${i + 1} of ${total}`);
    let raw = all.get(order[i]);
    if (raw == null) {
      const key = [...all.keys()].find((k) => k.toLowerCase() === order[i].toLowerCase());
      if (key) raw = all.get(key);
    }
    if (raw == null) continue;
    const { text, title: t } = parseMarkup(raw);
    if (!title && t) title = t;
    if (text) parts.push(text);
  }
  return { text: parts.join("\n\n"), title: opfTitle || title };
}

// --- odt --------------------------------------------------------------------
async function parseOdt(file) {
  const all = await readZipEntries(file, (p) => p === "content.xml");
  const xml = all.get("content.xml");
  if (!xml) throw new Error("couldn't read that document");
  const withBreaks = xml
    .replace(/<\/text:(p|h)>/gi, "\n\n")
    .replace(/<text:tab\/>/gi, "\t")
    .replace(/<text:line-break\/>/gi, "\n");
  const doc = new DOMParser().parseFromString("<div>" + withBreaks + "</div>", "text/html");
  return doc.body ? doc.body.textContent || "" : "";
}
