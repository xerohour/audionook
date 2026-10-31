// ===========================================================================
// reformat.js — AI text cleanup for the Create pane's "Reformat text" feature.
//
// A whole document is split into small, contiguous segments (a few hundred
// words each). Each segment is sent to generateText on its own, in order, and
// the model answers with compact EDIT lines that address the segment's numbered
// lines — so a segment only costs output tokens for the lines that actually
// change. Because a rewrite is just a range edit with a large span, the model
// is free to decide per segment whether a few small diffs or a full rewrite is
// the efficient answer; both come back through the same protocol.
//
// This module is DOM-free and runs anywhere: everything specific to the app
// (streaming UI, toasts, persistence) arrives through callbacks.
// ===========================================================================

import { wordCount } from "./util.js";

// ===========================================================================
// Presets
// ===========================================================================
export const REFORMAT_PRESETS = [
  {
    id: "audiobook",
    label: "Clean up into audiobook style",
    hint: "Strips page numbers, running heads, tables of contents and scan junk, and joins hard-wrapped lines into paragraphs.",
    task:
      "Prepare this segment for audiobook narration. Delete anything that existed only on a printed page: page numbers and page-number ranges, running headers and footers, copyright/ISBN/legal notices, Project Gutenberg and ebook licence blocks with their *** START/END OF *** markers, printer's marks, table-of-contents and list-of-figures entries, index entries, and figure or table captions and labels. A table of contents is a run of short lines that are only chapter or section titles, usually with no sentences between them; delete such a run even when the words \"Table of Contents\" appear nowhere in this segment, and delete the whole segment if it is nothing but such a list. Join a word that a line break split with a hyphen, and join hard-wrapped lines back into normal paragraphs so each paragraph is a single line. A running header or footer is sometimes run together with the text of a line — for example the book title glued onto the start of a sentence; cut the header or footer words out of the line and keep the sentence whole, and where a page number, a running header or blank lines split one sentence across a page break, join the two halves back together. Repair obvious scan/OCR damage: misread characters, stray symbols, broken spacing and broken quotation marks. Do not change the author's wording, style, names or the order of the content, and do not add or remove meaning.",
  },
  {
    id: "ocr",
    label: "Fix extraction errors only",
    hint: "A light touch: repairs OCR misreads, hyphenation and spacing, and drops stray page numbers — nothing else.",
    task:
      "Fix only clear extraction defects: join words that a line break split with a hyphen, join hard-wrapped lines into normal paragraphs, repair obvious OCR misreads and broken spacing, and delete standalone page numbers and running headers — including a running header or footer that has been glued onto the start or end of a line of text. Where a page number or running header splits one sentence across a page break, join the halves. Change nothing else — keep the wording, punctuation, headings and order exactly as they are.",
  },
  {
    id: "prose",
    label: "Reflow into clean prose",
    hint: "Joins hard-wrapped lines into paragraphs and tidies quotes, dashes and spacing.",
    task:
      "Reflow this segment into clean readable prose. Join hard-wrapped lines into full paragraphs (one paragraph per line), collapse broken spacing, normalise quotation marks, apostrophes and dashes to plain typographic characters, and delete page numbers and running headers. Keep the wording, headings and order of the content unchanged.",
  },
  {
    id: "custom",
    label: "Custom instruction…",
    hint: "Describe what the model should do to the text.",
    task: "",
  },
];

export function presetById(id) {
  return REFORMAT_PRESETS.find((p) => p.id === id) || REFORMAT_PRESETS[0];
}

// ===========================================================================
// Segmenting
// ===========================================================================
const wordsIn = (s) => wordCount(s);

// A single physical line that is absurdly long is split at sentence ends so no
// segment can blow past the model's output budget in one go.
function splitLongLine(line, maxWords) {
  if (wordsIn(line) <= maxWords) return [line];
  const sentences = line.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g) || [line];
  const pieces = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && wordsIn(cur) + wordsIn(s) > maxWords) { pieces.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) pieces.push(cur.trim());
  return pieces.length ? pieces : [line];
}

// Returns { lines, segments:[{a,b}] } where the segments are contiguous,
// non-overlapping, 0-based inclusive line ranges that together cover the whole
// document. No segment exceeds `maxWords`, and boundaries prefer paragraph gaps
// so a wrapped paragraph stays whole wherever it fits.
export function planSegments(text, { maxWords = 360 } = {}) {
  const src = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  const lines = [];
  for (const ln of src) {
    if (wordsIn(ln) > maxWords) lines.push(...splitLongLine(ln, maxWords));
    else lines.push(ln);
  }
  const wt = lines.map(wordsIn);

  // Paragraphs: runs of non-blank lines.
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].trim() !== "") j++;
    blocks.push([i, j]);
    i = j + 1;
  }

  // Split any oversized paragraph into pieces that fit. Cuts land on a line
  // boundary, and — for hard-wrapped prose — prefer a line that ends a sentence
  // (within a small tolerance) so a sentence is never sliced in half across
  // segments; short list/heading lines simply cut at the line boundary.
  const units = [];
  const endsSentence = (s) => /[.!?…]["'”’)\]]*\s*$/.test(s.trim());
  for (const [bi, bj] of blocks) {
    let a = bi, w = 0, k = bi;
    while (k <= bj) {
      w += wt[k];
      const atEnd = k === bj;
      const nextOverflows = !atEnd && w + wt[k + 1] > maxWords;
      if (atEnd || nextOverflows) {
        let cut = k;
        if (nextOverflows && !endsSentence(lines[k])) {
          let w2 = w;
          for (let m = k + 1; m <= bj && m <= k + 3 && w2 <= maxWords * 1.15; m++) {
            w2 += wt[m];
            if (endsSentence(lines[m])) { cut = m; break; }
          }
        }
        units.push([a, cut]);
        a = cut + 1;
        w = 0;
        k = cut + 1;
      } else {
        k++;
      }
    }
  }

  // Pack consecutive units back together up to the budget, so short paragraphs
  // keep each other company and long ones start a fresh segment.
  const segs = [];
  let cur = null;
  for (const [ui, uj] of units) {
    let uw = 0;
    for (let k = ui; k <= uj; k++) uw += wt[k];
    if (cur && cur.words + uw > maxWords) { segs.push({ a: cur.a, b: cur.b }); cur = null; }
    if (!cur) cur = { a: 0, b: uj, words: uw };
    else { cur.b = uj; cur.words += uw; }
  }
  if (cur) segs.push({ a: cur.a, b: cur.b });

  for (let k = 0; k < segs.length; k++) {
    segs[k].a = k === 0 ? 0 : segs[k - 1].b + 1;
  }
  if (segs.length) segs[segs.length - 1].b = lines.length - 1;
  return { lines, segments: segs };
}

// ===========================================================================
// Prompt
// ===========================================================================
// The static prefix (rules + examples) is identical for every call, and the
// task is identical for every call in one run, so the plugin's KV-prefix cache
// keeps all of that hot; only the final segment varies.
const SYSTEM = `You are the text-restoration engine of an audiobook converter. You are given one numbered SEGMENT of a document that was machine-extracted from a PDF, EPUB, scan or web page, plus a TASK. Apply the TASK to that segment and reply with EDIT lines.

HOW THE SEGMENT IS SHOWN
Every line is shown with its line number and a bar:
1| The quick brown fox
2| jumps over the lazy dog
3|
A completely blank line appears as just a number and a bar.

HOW TO REPLY — ONLY MENTION THE LINES THAT CHANGE
Any line you do not mention is copied through exactly as it is. So write edit lines ONLY for the lines you alter or delete: never repeat an unchanged line and never repeat the whole segment. Most segments need only a few edit lines.

Each edit line names the input line(s) it changes:
  12| corrected text       line 12 becomes "corrected text"
  12|                      line 12 is deleted
  12-14| one joined line   lines 12, 13 and 14 become this one line
  12-14|                   lines 12 to 14 are deleted
  12> an inserted line     insert "an inserted line" after line 12
To delete, leave the bar with NOTHING after it. Never write words like "delete" after the bar: to delete the whole segment the correct reply is just "1-79|".

Use the smallest edit that does the job:
- Joining a hard-wrapped sentence or paragraph: one range edit over the whole run.
- Deleting consecutive boilerplate (page numbers, running heads, table-of-contents entries, captions, licence text): a range delete.
- Fixing one misread word, space or punctuation mark: edit just that line.
- When almost everything must change (heavy cleanup, translation, restructuring), REWRITE the segment with a few large range edits that between them cover it, one per output paragraph, e.g. rewriting 40 lines as two paragraphs:
1-22| the first rewritten paragraph
23-40| the second rewritten paragraph

RULES
- Never invent, summarise, censor or reorder content. Keep every name, number, quotation and fact.
- Delete only what the TASK asks you to delete; when in doubt, keep it.
- Only use line numbers that exist in the segment, and never touch anything outside it.
- Keep the original language unless the TASK says otherwise.
- A paragraph that spans several input lines becomes ONE output line, and the blank line separating it from the next paragraph is kept.
- Keep headings on their own lines, worded exactly as they are.
- Reply with edit lines ONLY — no explanations, no notes, no code fences, no headings, and no blank lines between the edits. If the segment already satisfies the TASK, reply with exactly: NONE`;

const EXAMPLES = `EXAMPLES

Segment:
1| The town of Salem was founded
2| in 1626 by Roger Conant.
3| 27
4| [Illustration: the old wharf]
5| In 1692 the trials began.
TASK: join hard-wrapped lines; delete page numbers, captions and other non-narrative clutter.
Reply:
1-2| The town of Salem was founded in 1626 by Roger Conant.
3|
4|

Segment:
1| The meeting was cancelled.
2| Nobody was surprised.
TASK: translate to French.
Reply:
1| La réunion a été annulée.
2| Personne n'a été surpris.`;

export function buildSegmentPrompt(task, segLines) {
  const numbered = segLines.map((l, i) => `${i + 1}| ${l}`).join("\n");
  return `${SYSTEM}

${EXAMPLES}

TASK
${task}

SEGMENT
${numbered}`;
}

// ===========================================================================
// Parsing the model's reply
// ===========================================================================
const EDIT_RE = /^\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*([|:>])\s?(.*)$/;
const NO_CHANGE_RE = /^(none|no changes?|nothing to change|unchanged|the segment (is )?already|already (correct|clean|fine)|no edits?)[.!]?$/i;
const COMMENT_RE = /^(here (is|are)|sure|below (is|are)|note\b|the (following|rewritten|corrected|cleaned|edited)|rewritten|corrected|output|edits?|rewrite|i (have|'ve|made))/i;

// The model sometimes answers "3-9| delete lines 3 to 9" instead of leaving the
// replacement empty. A short replacement that is plainly a command rather than
// prose means "delete", so treat it as one.
function looksLikeDeleteCommand(s) {
  const t = String(s || "").trim();
  if (!t || t.length > 60) return false;
  if (/^[\[(<]?\s*(?:blank|empty|deleted|nothing|none)\s*[\])>]?\.?$/i.test(t)) return true;
  const verb = /^(?:please\s+)?(?:delete|remove|omit|drop|cut|excise)\b/i.test(t);
  if (!verb) return false;
  return /\b(?:all|entire|whole|everything|lines?|segment|text|content|contents|these|those|them|it|this|24)\b/i.test(t);
}

function stripFences(s) {
  return String(s || "")
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "");
}

// Turn the model's raw reply into ops. `lineCount` = number of lines in the
// segment. Returns { mode, ops, warnings, raw }.
export function parseSegmentResponse(raw, lineCount, segWords = 0) {
  const warnings = [];
  const text = stripFences(String(raw == null ? "" : raw)).replace(/\r\n?/g, "\n");
  const rows = text.split("\n");
  const ops = [];
  const stray = [];
  let open = null;

  const push = (op) => { ops.push(op); open = op; };

  for (const row of rows) {
    const line = row.replace(/\s+$/, "");
    const m = EDIT_RE.exec(line);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : start;
      const kind = m[3];
      if (kind === ">") push({ type: "insert", at: end, text: m[4], cont: [] });
      else push({ type: "replace", start, end, text: m[4], cont: [] });
    } else if (line.trim() === "") {
      // blank lines are layout, never content
    } else if (open && open.type === "replace" && open.end > open.start && !COMMENT_RE.test(line.trim())) {
      // a multi-line rewrite may be wrapped onto continuation lines
      open.cont.push(line);
    } else {
      stray.push(line);
    }
  }

  for (const op of ops) op.full = [op.text, ...op.cont].join("\n").replace(/\s+$/, "");

  for (const op of ops) {
    if (op.type === "replace" && op.full !== "" && looksLikeDeleteCommand(op.full)) op.full = "";
  }

  const valid = [];
  for (const op of ops) {
    const opLine = op.type === "insert" ? op.at : op.start;
    if (opLine < 0 || opLine > lineCount) { warnings.push(`line ${opLine} out of range`); continue; }
    if (op.type === "replace") {
      if (op.end < op.start) { warnings.push(`bad range ${op.start}-${op.end}`); continue; }
      if (op.end > lineCount) { op.end = lineCount; warnings.push("range clamped"); }
    }
    valid.push(op);
  }

  if (valid.length) {
    // The model may have echoed a preamble ("Here are the edits:") — ignore it.
    if (stray.length) warnings.push("ignored extra text");
    return { mode: "edits", ops: valid, warnings, raw: text };
  }

  const cleaned = stray.join("\n").trim().replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
  if (!cleaned || NO_CHANGE_RE.test(cleaned)) return { mode: "none", ops: [], warnings, raw: text };

  // Some tasks (translation, heavy restructure) tempt the model into ignoring
  // the edit syntax and just writing the new text. If the reply looks like a
  // plausible replacement for the segment, accept it as a full rewrite.
  const w = wordsIn(cleaned);
  const ratio = segWords > 0 ? w / segWords : 1;
  if (w >= 12 && ratio >= 0.4 && ratio <= 3) {
    return { mode: "rewrite", ops: [{ type: "replace", start: 1, end: lineCount, full: cleaned, cont: [] }], warnings, raw: text };
  }

  return { mode: "unparsed", ops: [], warnings, raw: text };
}

// Ops are expressed against the ORIGINAL segment line numbers; this builds the
// new segment as a plain array of lines.
export function applyOps(lines, ops) {
  const inserts = new Map();
  for (const op of ops) {
    if (op.type !== "insert") continue;
    const at = Math.max(0, Math.min(lines.length, op.at));
    const list = inserts.get(at) || [];
    list.push(...(op.full === "" ? [] : op.full.split("\n")));
    inserts.set(at, list);
  }
  const repl = ops.filter((o) => o.type === "replace").sort((a, b) => a.start - b.start);
  const clean = [];
  for (const o of repl) {
    if (clean.length && o.start <= clean[clean.length - 1].end) continue; // drop overlaps
    clean.push(o);
  }
  const out = [];
  const emit = (anchor) => { const list = inserts.get(anchor); if (list) out.push(...list); };
  let ri = 0;
  for (let i = 1; i <= lines.length; i++) {
    emit(i - 1);
    const o = clean[ri];
    if (o && o.start === i) {
      if (o.full !== "") out.push(...o.full.split("\n"));
      i = o.end;
      ri++;
    } else {
      out.push(lines[i - 1]);
    }
  }
  emit(lines.length);
  return out;
}

// ===========================================================================
// Line diff (for the "where did it change?" view)
// ===========================================================================
export function diffLines(before, after) {
  const n = before.length, m = after.length;
  if (!n && !m) return [];
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { out.push({ t: "ctx", text: before[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", text: before[i] }); i++; }
    else { out.push({ t: "add", text: after[j] }); j++; }
  }
  while (i < n) out.push({ t: "del", text: before[i++] });
  while (j < m) out.push({ t: "add", text: after[j++] });
  return out;
}

// Collapse long runs of unchanged lines so a segment stays short on screen.
export function condenseDiff(diff, context = 2) {
  const keep = new Array(diff.length).fill(false);
  for (let i = 0; i < diff.length; i++) {
    if (diff[i].t === "ctx") continue;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep[k] = true;
  }
  const out = [];
  let gap = 0;
  for (let i = 0; i < diff.length; i++) {
    if (keep[i]) {
      if (gap) { out.push({ t: "gap", n: gap }); gap = 0; }
      out.push(diff[i]);
    } else gap++;
  }
  if (gap) out.push({ t: "gap", n: gap });
  return out;
}

// A document cut into segments can slice one sentence in two at a boundary — a
// PDF page break, say, where a page number sits between the halves. Within a
// segment the model joins such fragments, but it cannot see across a boundary.
// This is the safety net: two text lines are one broken sentence when the first
// does not end with sentence punctuation and the second starts with a lowercase
// letter. Only that narrow case is joined, and a blank line between them (left
// by the page break) does not block the join.
const SENTENCE_END_RE = /[.!?…:;]["'”’»)\]]*\s*$/;
const startsLower = (s) => /^[a-zà-öø-ÿ]/.test(s);
function doJoin(a, b) {
  if (/[A-Za-zà-öø-ÿ]-$/.test(a)) return a.slice(0, -1) + b;   // de-hyphenate
  if (/[—–]$/.test(a)) return a + b;                           // dash: no space
  return a + " " + b;
}
function wantsJoin(a, b) {
  return a !== "" && b !== "" && !SENTENCE_END_RE.test(a) && startsLower(b);
}
export function mergeContinuations(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] == null ? "" : lines[i];
    if (line !== "") {
      const prev = out[out.length - 1];
      if (prev !== undefined && wantsJoin(prev.trimEnd(), line.trim())) {
        out[out.length - 1] = doJoin(prev.replace(/\s+$/, ""), line.replace(/^\s+/, ""));
      } else out.push(line);
      continue;
    }
    // A blank run: drop it when it merely hides a broken sentence.
    let j = i;
    while (j < lines.length && (lines[j] == null ? "" : lines[j]) === "") j++;
    const prev = out[out.length - 1];
    const next = j < lines.length ? lines[j] : null;
    if (prev !== undefined && next != null && wantsJoin(prev.replace(/\s+$/, ""), next.replace(/^\s+/, ""))) {
      out[out.length - 1] = doJoin(prev.replace(/\s+$/, ""), next.replace(/^\s+/, ""));
      i = j;
    } else {
      for (let k = i; k < j; k++) out.push("");
      i = j - 1;
    }
  }
  return out;
}

export function diffStats(diff) {
  let added = 0, removed = 0;
  for (const d of diff) { if (d.t === "add") added++; else if (d.t === "del") removed++; }
  return { added, removed };
}

// Describe a finished segment in a few words for its badge.
export function describeResult(res) {
  if (res.failed) return { label: "failed", kind: "fail" };
  if (res.parsed.mode === "unparsed") return { label: "no reply", kind: "fail" };
  if (!res.changed) return { label: "unchanged", kind: "plain" };
  if (res.parsed.mode === "rewrite") return { label: "rewritten", kind: "rewrite" };
  const { added, removed } = diffStats(res.diff);
  const parts = [];
  if (removed) parts.push(`−${removed}`);   // U+2212
  if (added) parts.push(`+${added}`);
  return { label: parts.join(" ") || "edited", kind: "edit" };
}

// ===========================================================================
// Sequential runner
// ===========================================================================
export class Reformatter {
  // generate: (instruction, onChunk) => Promise<string-like>
  constructor({ generate, onStart, onSegmentStart, onSegmentDelta, onSegmentEnd, onFinish, maxWords = 360 }) {
    this.generate = generate;
    this.onStart = onStart;
    this.onSegmentStart = onSegmentStart;
    this.onSegmentDelta = onSegmentDelta;
    this.onSegmentEnd = onSegmentEnd;
    this.onFinish = onFinish;
    this.maxWords = maxWords;
    this.aborted = false;
    this._current = null;
  }

  stop() {
    this.aborted = true;
    const cur = this._current;
    if (cur && typeof cur.stop === "function") { try { cur.stop(); } catch (e) {} }
  }

  // Run a single segment on its own — used to retry one that failed.
  processSegment(segLines, task, index = 0, total = 1) {
    return this._segment(segLines, task, index, total);
  }

  async _segment(segLines, task, index, total) {
    const instruction = buildSegmentPrompt(task, segLines);
    let raw = "";
    let res = null;
    let failed = false;
    try {
      const run = this.generate(instruction, (chunk) => {
        raw += chunk;
        if (this.onSegmentDelta) this.onSegmentDelta(index, chunk, raw);
      });
      this._current = run;
      const awaited = await run;
      res = typeof awaited === "string" ? awaited : String((awaited && awaited.text) || "");
    } catch (e) {
      failed = true;
      res = "";
    } finally {
      this._current = null;
    }
    const segWords = wordsIn(segLines.join(" "));
    const parsed = failed
      ? { mode: "unparsed", ops: [], warnings: ["request failed"], raw: "" }
      : parseSegmentResponse(res, segLines.length, segWords);
    const newLines = mergeContinuations(parsed.ops.length ? applyOps(segLines, parsed.ops) : segLines.slice());
    const diff = diffLines(segLines, newLines);
    const changed = newLines.length !== segLines.length || newLines.some((l, k) => l !== segLines[k]);
    return { index, total, before: segLines, after: newLines, parsed, diff, changed, failed, raw: res };
  }

  async run(text, task) {
    const { lines, segments } = planSegments(text, { maxWords: this.maxWords });
    const total = segments.length;
    if (this.onStart) this.onStart({ total, lines: lines.length });
    const results = [];
    let working = lines.slice();
    for (let i = 0; i < total; i++) {
      if (this.aborted) break;
      const seg = segments[i];
      const segLines = lines.slice(seg.a, seg.b + 1);
      if (this.onSegmentStart) this.onSegmentStart(i, total, segLines);
      const res = await this._segment(segLines, task, i, total);
      results.push(res);
      // Rebuild the visible working text: finished segments in their new form,
      // plus the untouched remainder.
      const done = [];
      for (const r of results) done.push(...r.after);
      const restStart = seg.b + 1;
      working = done.concat(lines.slice(restStart));
      if (this.onSegmentEnd) this.onSegmentEnd(res, working.join("\n"));
    }
    const mergedWorking = mergeContinuations(working);
    const finalText = mergedWorking.join("\n");
    const summary = {
      total,
      processed: results.length,
      stopped: this.aborted,
      failed: results.filter((r) => r.failed || r.parsed.mode === "unparsed").length,
      changed: results.filter((r) => r.changed).length,
      joinedSeams: Math.max(0, working.length - mergedWorking.length),
      results,
      text: finalText,
    };
    if (this.onFinish) this.onFinish(summary);
    return summary;
  }
}
