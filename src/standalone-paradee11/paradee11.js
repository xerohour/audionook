// ===========================================================================
// paradee11.js — portable Paradee v1.1 text-to-speech for any web app/game.
//
// One 8M-parameter voice ("Heart", af_heart student) that runs ~50x realtime
// on a single CPU thread: no WebGPU, no 325 MB download, no server. Everything
// the workers need ships in ONE ~20 MB binary Sesame-note: fetched ONCE and
// shared by the whole pool.
//
// QUICKSTART:
//   import { createParadee } from "https://<uploaded-url>/paradee11.js";
//   const tts = await createParadee();              // downloads bundle once
//   const mp3 = await tts.say("Hello, world!");    // Blob(audio/mp3), playable
//   new Audio(URL.createObjectURL(mp3)).play();
//
// LONG TEXT (audiobooks, any length — handled automatically):
//   const mp3 = await tts.say(chapterText, {
//     onChunk: (mp3Blob, index, total) => queueForPlayback(mp3Blob),
//   });
//   // => one combined MP3 Blob. sayLong() is a legacy alias (see below).
//
// RAW ACCESS:
//   const { audio, sampleRate } = await tts.sayRaw("Hello"); // Float32Array @24kHz
//   const wav = await tts.sayWav("Hello");                   // Blob(audio/wav)
//
// RULES THE LIB LIVES BY:
// - At most half of navigator.hardwareConcurrency background threads, ever
//   (default pool = min(8, floor(cores/2)); a 4-core phone uses 2 workers).
// - Workers make ZERO runtime fetches: model + ORT runtime + tokenizer all
//   arrive as memory-served blob URLs from the single bundle download.
// - Pinned dependencies (no floating versions):
//     ORT  : https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs
//            (wasm-only entry — NOT the default all-backend bundle, which
//            force-loads a 22 MB side module per worker)
//     G2P  : https://esm.sh/kokoro-js@1.2.1?target=es2022 (+ its deps)
//     TOK  : https://esm.sh/@huggingface/transformers@3.5.1 (tokenizer only;
//            its ORT copy is never used — no session is ever created from it)
//     MP3  : https://esm.sh/lamejs@1.2.1 (main-thread encode, CBR 128k mono)
// - Single voice (the student only ever learned af_heart). Unlimited,
//   fully local synthesis — your text never leaves the device.
//
// BUNDLE: src/paradee11-rt.bundle equivalent, built by the build script
// (see README). Layout: magic[8]="P11BNDL1" | u32LE headerLen | headerJSON |
// payloads (ort-mjs, ort-wasm, model-int8, tokenizer).
// ===========================================================================

export const PARADEE11_VERSION = "1.1";
export const PARADEE11_SAMPLE_RATE = 24000;
export const PARADEE11_VOICE_NAME = "Heart (Light)";

// Pinned runtime URLs — override via createParadee({ urls }) if you must.
export const PARADEE11_URLS = {
  ort: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs",
  kokoro: "https://esm.sh/kokoro-js@1.2.1?target=es2022",
  transformers: "https://esm.sh/@huggingface/transformers@3.5.1?target=es2022",
  lame: "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js",
  // Default bundle location: the published single binary (see README).
  bundle: "https://user.uploads.dev/file/4047fc593b6dbd67b109ac649e014ac6.bin",
};

// Lowercased tokens (runs of dots collapsed) that end in a period but do NOT
// end a sentence. Kept deliberately broad: a missed abbreviation only costs us
// a slightly longer chunk, whereas a false positive produces a weird split.
const ABBREVIATIONS = new Set([
  // titles / people
  "mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st", "mt", "ft", "hon",
  "rev", "fr", "gen", "col", "capt", "cmdr", "lt", "sgt", "maj", "adm", "gov",
  "sen", "rep", "pres", "supt", "det", "insp", "messrs", "mme", "mlle",
  // latin / reference
  "etc", "vs", "viz", "al", "ca", "cf", "ed", "eds", "trans", "ibid", "op", "cit",
  "eg", "ie", "nb", "ps", "pp", "vol", "vols", "no", "nos", "fig", "figs", "p", "ch", "chs",
  "sec", "secs", "art", "arts", "pt", "pts", "ref", "refs", "para", "paras", "ex", "exs",
  // business / place
  "inc", "ltd", "co", "corp", "dept", "univ", "ave", "blvd", "rd", "st", "sq", "apt",
  "ste", "bldg", "hwy", "rte", "is", "isla", "dist", "mfg", "bros", "assn", "est",
  // measures / misc
  "min", "max", "approx", "avg", "doz", "hr", "hrs", "sec", "yr", "yrs", "wk", "mo",
  "wt", "oz", "lb", "lbs", "gal", "qt", "pt", "fl", "dept",
  // months / days
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  // degrees / academic
  "ph.d", "m.d", "b.a", "m.a", "b.s", "m.s", "b.sc", "m.sc", "d.d.s", "d.v.m", "r.n", "j.d", "esq",
]);

const CLOSER_RE = /["'’”)\]}]/;
// chars that may appear inside a "token" when scanning backwards from a dot
const TOKEN_CHAR_RE = /[A-Za-z0-9.'’]/;

// Scan backwards from the dot at `i` and return the "word-ish" token ending
// there, INCLUDING the dot, e.g. "Mr.", "U.S.", "Ph.D.", "example.com".
function tokenEndingAt(str, i) {
  let j = i;
  while (j >= 0 && TOKEN_CHAR_RE.test(str[j])) j--;
  // A leading quote is not part of the token: `'Mr.` -> `Mr.`
  return str.slice(j + 1, i + 1).replace(/^['’]+/, "");
}

function nextMeaningful(str, i) {
  let j = i + 1;
  while (j < str.length && /\s/.test(str[j])) j++;
  if (j >= str.length) return "";
  let c = str[j];
  if (CLOSER_RE.test(c)) {
    j++;
    while (j < str.length && /\s/.test(str[j])) j++;
    c = j < str.length ? str[j] : "";
  }
  return c;
}

// Dotted acronym / initialism: "U.S.", "K.I.S.S.", "e.g.", "Ph.D."
const ACRONYM_RE = /^(?:[A-Za-z]{1,3}\.){2,}$/;
// Known abbreviations ("Mr.", "etc.", "Dr.", ...), lowercased, runs collapsed.
function isKnownAbbrev(tok) {
  const key = tok.toLowerCase().replace(/\.{2,}/g, ".");
  return ABBREVIATIONS.has(key) || ABBREVIATIONS.has(key.replace(/\.$/, ""));
}

// Whether the "." at index i terminates a sentence (as opposed to ending an
// abbreviation, acronym, initial, decimal, domain, etc).
function isSentenceEndDot(str, i) {
  if (str[i] !== ".") return false;
  // Only the final dot of a run ("...") is ever a boundary.
  if (str[i + 1] === ".") return false;
  const prev = str[i - 1];
  const next = str[i + 1];
  // decimals / version numbers / ranges: digit . digit
  if (prev && next && /[0-9]/.test(prev) && /[0-9]/.test(next)) return false;
  // A period immediately followed by mid-sentence punctuation is never terminal
  // (e.g. an initial before a comma: "set off from B., intending...").
  if (next === "," || next === ";" || next === ":") return false;

  const token = tokenEndingAt(str, i);
  const nm = nextMeaningful(str, i);

  // acronyms & dotted initialisms: "U.S.", "K.I.S.S.", "e.g.", "a.k.a.", "Ph.D."
  if (ACRONYM_RE.test(token)) return false;

  // known abbreviations ("Mr.", "etc.", "Dr.", ...)
  if (isKnownAbbrev(token)) return false;

  // emails are never sentences ("user@host.org"); a domain is only non-terminal
  // when the sentence clearly continues (lowercase next word) — otherwise
  // "…at example.com. Then we left." should still break.
  if (token.includes("@")) return false;
  if (/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+$/i.test(token.replace(/\.$/, "")) && !/[A-Z]/.test(nm)) return false;

  // initials: "J. Smith", "R. R. Tolkien" (but not "I." / "A." which are words)
  if (/^[A-Z]\.$/.test(token) && /[A-Z]/.test(nm) && token[0] !== "I" && token[0] !== "A") return false;

  // A period followed by a lowercase letter is almost never a sentence end
  // (typos, abbreviations we don't know, "in the U.S. army", etc).
  if (nm && /[a-z]/.test(nm)) return false;

  return true;
}

// Whether the character just before `idx` is a sentence-ending piece of
// punctuation. Used for newline splits and closing quotes.
function isSentenceEndPrev(str, idx) {
  let j = idx - 1;
  while (j >= 0 && CLOSER_RE.test(str[j])) j--;
  if (j < 0) return false;
  const c = str[j];
  if (c === "!" || c === "?") return true;
  if (c === ".") return isSentenceEndDot(str, j);
  return false;
}

// Deliberately loose: would splitting at the space `spaceIdx` land right after a
// token that looks like an abbreviation/acronym/initial ("Mr.", "U.S.", "J.")?
// We use this only to *bias* whitespace-fallback splits away from odd points.
function isAwkwardSpaceBreak(str, spaceIdx) {
  const tok = tokenEndingAt(str, spaceIdx - 1);
  if (!tok) return false;
  if (ACRONYM_RE.test(tok)) return true;
  if (isKnownAbbrev(tok)) return true;
  if (/^[A-Z]\.$/.test(tok)) return true;
  return false;
}

export function splitTextIntoChunks(text, maxSize = 300) {
  text = text.replaceAll("*", ""); // kokoro "speaks out" the asterisks so we remove them
  text = text.replace(/\r\n|\r/g, "\n");
  text = text.replace(/[“”]/g, '"');
  text = text.replace(/[‘’]/g, "'");

  let chunks = [];
  let start = 0;

  let lastDelimiter = -1;     // sentence enders
  let lastSubDelimiter = -1;  // comma/colon/semicolon
  let lastSpace = -1;         // word boundary

  // True means: the *next* non-empty chunk begins a new paragraph
  let nextIsStartOfParagraph = false;

  const pushChunk = (end) => {
    const trimmed = text.slice(start, end).trim();
    if (trimmed) {
      chunks.push({ isStartOfParagraph: nextIsStartOfParagraph, text: trimmed });
      nextIsStartOfParagraph = false;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // --- 1) Detect paragraph break: "\n" + optional spaces/tabs + "\n"
    if (ch === "\n") {
      let j = i + 1;
      while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;

      // If we find another newline after only whitespace => blank line => paragraph break
      if (j < text.length && text[j] === "\n") {
        pushChunk(i);

        let k = i;
        while (k < text.length) {
          if (text[k] !== "\n") break;
          k++;
          while (k < text.length && (text[k] === " " || text[k] === "\t")) k++;
          if (k < text.length && text[k] === "\n") continue;
          break;
        }

        start = k;
        i = k - 1; // continue scanning from the next real character

        lastDelimiter = lastSubDelimiter = lastSpace = -1;
        nextIsStartOfParagraph = true;
        continue;
      }

      // Single newline: treat as a split point only if it follows sentence-end punctuation
      if (isSentenceEndPrev(text, i)) {
        lastDelimiter = i; // split *before* the newline
      }
    }

    // --- 2) Track potential split points
    if (ch === "." ) {
      if (isSentenceEndDot(text, i)) lastDelimiter = i + 1;
    } else if (ch === "!" || ch === "?") {
      lastDelimiter = i + 1; // include punctuation
    } else if (ch === '"') {
      if (isSentenceEndPrev(text, i)) lastDelimiter = i + 1;
    } else if (ch === ",") {
      // don't split inside grouped numbers ("1,000")
      const p = text[i - 1], n = text[i + 1];
      if (!(p && n && /[0-9]/.test(p) && /[0-9]/.test(n))) lastSubDelimiter = i + 1;
    } else if (ch === ";" || ch === ":") {
      lastSubDelimiter = i + 1; // include punctuation
    } else if (ch === " ") {
      // Bias whitespace-fallback splits away from odd points: if this space
      // directly follows an abbreviation/acronym/initial ("Mr. | Darcy",
      // "U.S. | Army"), fall back to an earlier, more natural space.
      let sp = i;
      let guard = 0;
      while (sp > start && isAwkwardSpaceBreak(text, sp) && guard++ < 40) {
        let k = sp - 1;
        while (k > start && !/\s/.test(text[k])) k--;
        if (k <= start) break;
        sp = k;
      }
      lastSpace = sp + 1;
    }

    // --- 3) Size-based split
    if (i - start >= maxSize) {
      let end =
        (lastDelimiter > start && lastDelimiter) ||
        (lastSubDelimiter > start && lastSubDelimiter) ||
        (lastSpace > start && lastSpace) ||
        0;

      if (!end) {
        // No break point at all (e.g. a giant URL/hash). Reach forward to the
        // next whitespace so we don't slice a word in half.
        let k = i;
        while (k < text.length && k - i < 60 && !/\s/.test(text[k])) k++;
        end = Math.min(text.length, k);
        if (end <= start) end = i; // ultra-long single word: force split
      }

      pushChunk(end);

      start = end;
      i = end - 1; // reprocess from new start next loop
      lastDelimiter = lastSubDelimiter = lastSpace = -1;
    }
  }

  // Remainder
  pushChunk(text.length);

  chunks = chunks.filter(c => c.text.replace(/[-#]+/g, "").trim()); // remove chunks that are just e.g. "---" or "###"
  for (let chunk of chunks) {
    chunk.text = chunk.text.replace(/^#+/, "").trim(); // remove hashes before markdown headers
  }

  return chunks;
}
// --- sentence chunker (vendored from the Audionook engine) -------------------

// --- toMisaki ---------------------------------------------------------------
// kokoro-js phonemizes with eSpeak NG, but Paradee only ever saw phonemes from
// misaki (Kokoro's own G2P) in training. The two spell the same sounds
// differently ("aɪ" vs "I", "oʊ" vs "O", length marks, flaps), and fed raw
// eSpeak phonemes Paradee mumbles (Whisper word error rate 31% vs 3%). This is
// misaki's own eSpeak-to-misaki table (misaki/espeak.py, EspeakFallback,
// American English), adapted to eSpeak output that has no tie marks between the
// two halves of a diphthong.
//
// Vendored from https://github.com/sahilmahendrakar/paradee/blob/main/web/misaki.js
// (Apache-2.0, same as Kokoro). The TTS worker embeds this function's source,
// so keep it dependency-free and self-contained.
export function toMisaki(ps) {
  const E2M = [
    ["ʔˌn̩", "ʔn"], ["ʔn̩", "ʔn"],
    ["aɪ", "I"], ["aʊ", "W"],
    ["dʒ", "ʤ"],
    ["eɪ", "A"], ["e", "A"],
    ["tʃ", "ʧ"],
    ["ɔɪ", "Y"],
    ["ʲo", "jo"], ["ʲə", "jə"], ["ʲ", ""],
    ["ɚ", "əɹ"],
    ["r", "ɹ"],
    ["x", "k"], ["ç", "k"],
    ["ɬ", "l"],
    ["̃", ""],
  ];
  for (const [a, b] of E2M) ps = ps.split(a).join(b);
  ps = ps.replace(/(\S)̩/gu, "ᵊ$1").replace(/̩/g, "");
  // misaki writes a syllabic l at the end of a word as ᵊl (naval -> nˈAvᵊl).
  // eSpeak marks it with a tie that kokoro-js drops, so key on word-final əl.
  ps = ps.replace(/əl(?=[\s;:,.!?—…"“”()]|$)/gu, "ᵊl");
  // misaki's table maps ɐ to ə, but misaki's own lexicon keeps ɐ for the article "a"
  ps = ps.replace(/ɐ(?![\s;:,.!?—…"“”()]|$)/gu, "ə");
  ps = ps.split("oʊ").join("O")
    .split("ɜːɹ").join("ɜɹ").split("ɜː").join("ɜɹ")
    .split("ɪə").join("iə")
    .split("ː").join("");
  ps = ps.split("o").join("ɔ");
  return ps.split("ɾ").join("T").split("ʔ").join("t");
}

// --- background-thread budget ------------------------------------------------
// HARD RULE: background workers never exceed half of
// navigator.hardwareConcurrency. A 4-core phone gets 2 TTS workers, a 64-core
// desktop 8 (eat less than the 16 Audionook allows — games need their cores).
export function cpuBudget(cores) {
  return Math.max(1, Math.floor((cores || 4) / 2));
}

export function defaultWorkerCount(cores) {
  // One thread of the budget is reserved for the single MP3 encoder worker,
  // so TTS + MP3 combined stay within half of hardwareConcurrency.
  return Math.max(1, Math.min(8, cpuBudget(cores) - 1));
}

// --- single-file bundle loader ------------------------------------------------
// Layout: magic[8]="P11BNDL1" | u32LE headerLen | headerJSON | payloads.
// Returns memory-served blob URLs + the parsed tokenizer. Single-flighted per
// createParadee() call (and cheap to call again — the fetch itself is cached).
const _BUNDLE_MAGIC = "P11BNDL1";

export async function loadBundle(bundleUrl, onProgress) {
  try { onProgress && onProgress({ phase: "bundle", progress: 0 }); } catch (e) {}
  const res = await fetch(bundleUrl);
  if (!res.ok) throw new Error("paradee11: bundle fetch failed: HTTP " + res.status);
  const buf = await res.arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (new TextDecoder().decode(u8.slice(0, 8)) !== _BUNDLE_MAGIC) {
    throw new Error("paradee11: not a paradee11 bundle (bad magic)");
  }
  const headerLen = new DataView(buf).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(u8.slice(12, 12 + headerLen)));
  const section = (name) => {
    const f = (header.files || []).find((x) => x.name === name);
    if (!f) throw new Error("paradee11: bundle missing section " + name);
    return u8.slice(f.offset, f.offset + f.length);
  };
  const ortMjs = section("ort-mjs");
  const probe = new TextDecoder().decode(ortMjs); // 21 KB — decode it all
  if (probe.indexOf("ort-wasm-simd-threaded.wasm") < 0 || probe.indexOf("jsep") >= 0) {
    throw new Error("paradee11: bundle ort glue failed sanity check");
  }
  try { onProgress && onProgress({ phase: "bundle", progress: 1 }); } catch (e) {}
  return {
    header,
    bytes: buf.byteLength,
    ortMjsUrl: URL.createObjectURL(new Blob([ortMjs], { type: "text/javascript" })),
    ortWasmUrl: URL.createObjectURL(new Blob([section("ort-wasm")], { type: "application/wasm" })),
    modelUrl: URL.createObjectURL(new Blob([section("model-int8")], { type: "application/octet-stream" })),
    tokenizerJson: JSON.parse(new TextDecoder().decode(section("tokenizer"))),
  };
}

// --- TTS worker ---------------------------------------------------------------
// Module worker, built from this source string. Imports are pinned absolute
// URLs (no bundler needed); the heavy bytes (ORT wasm, model, tokenizer)
// arrive via init params as blob URLs / objects, so the worker's only network
// traffic is the three properly-cacheable JS imports.
function workerSource(urls) {
  return (
    "import { KokoroTTS } from '" + urls.kokoro + "';\n" +
    "import { PreTrainedTokenizer } from '" + urls.transformers + "';\n" +
    "import * as ort from '" + urls.ort + "';\n" +
    "const toMisaki = (" + toMisaki.toString() + ");\n" +
    "let tts = null;\n" +
    "async function initTTS(p) {\n" +
    "  try {\n" +
    "    if (p.ortMjsUrl || p.ortWasmUrl) {\n" +
    "      const wp = {};\n" +
    "      if (p.ortMjsUrl) wp.mjs = p.ortMjsUrl;\n" +
    "      if (p.ortWasmUrl) wp.wasm = p.ortWasmUrl;\n" +
    "      ort.env.wasm.wasmPaths = wp;\n" +
    "    }\n" +
    "  } catch (e) {}\n" +
    "  try { ort.env.wasm.numThreads = 1; } catch (e) {}\n" +
    "  const INT8 = [p.modelUrl, p.fallbackInt8];\n" +
    "  const tok = new PreTrainedTokenizer(p.tokenizerJson, { model_max_length: 512, pad_token: '$', unk_token: '$' });\n" +
    "  const t = new KokoroTTS(null, function (phonemes, opts) { return tok(toMisaki(phonemes), opts); });\n" +
    "  let session = null, lastErr = null;\n" +
    "  for (const url of INT8) {\n" +
    "    if (!url) continue;\n" +
    "    try { session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] }); break; }\n" +
    "    catch (e) { lastErr = e; }\n" +
    "  }\n" +
    "  if (!session) throw lastErr || new Error('paradee11: model load failed');\n" +
    "  t.generate_from_ids = async function (ids) {\n" +
    "    const out = await session.run({\n" +
    "      input_ids: new ort.Tensor('int64', ids.data, ids.dims),\n" +
    "      speed: new ort.Tensor('float32', new Float32Array([1]), [1]),\n" +
    "    });\n" +
    "    const wv = out.waveform || out[Object.keys(out)[0]];\n" +
    "    return { audio: wv.data, sampling_rate: 24000 };\n" +
    "  };\n" +
    "  tts = t;\n" +
    "  postMessage({ type: 'ready' });\n" +
    "}\n" +
    "self.onmessage = async function (e) {\n" +
    "  const d = e.data || {};\n" +
    "  if (d.type === 'init') {\n" +
    "    try { await initTTS(d.params); }\n" +
    "    catch (err) { postMessage({ type: 'error', index: -1, error: String((err && err.message) || err) }); }\n" +
    "    return;\n" +
    "  }\n" +
    "  if (d.type === 'process') {\n" +
    "    try {\n" +
    "      const audio = await tts.generate(d.text, { voice: 'af_heart' });\n" +
    "      let out = audio.audio;\n" +
    "      if (d.paragraphPause && d.isStartOfParagraph) {\n" +
    "        const n = Math.round(24000 * (0.1 + 0.2 * Math.min(1, d.text.length / 150)));\n" +
    "        const withPause = new Float32Array(n + out.length);\n" +
    "        withPause.set(out, n);\n" +
    "        out = withPause;\n" +
    "      }\n" +
    "      postMessage({ type: 'chunk', index: d.index, audio: out, sampleRate: 24000 }, [out.buffer]);\n" +
    "    } catch (err) {\n" +
    "      postMessage({ type: 'error', index: d.index, error: String((err && err.message) || err) });\n" +
    "    }\n" +
    "  }\n" +
    "};\n"
  );
}

// --- WAV + MP3 ----------------------------------------------------------------
export function floatToWavBlob(audio, sampleRate) {
  const n = audio.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, "data");
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, audio[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

let _mp3Worker = null;
const _mp3Waiters = new Map();
let _mp3Id = 1;
// One classic worker for MP3 (lamejs is UMD — importScripts only, which
// module workers lack). Single worker by design: it is part of the
// half-cores budget (see createParadee), and one encoder keeps up with
// interactive use; sayLong bulk encodes queue behind it.
function mp3Worker(lameUrl) {
  if (_mp3Worker) return _mp3Worker;
  const src =
    "importScripts('" + lameUrl + "');\n" +
    "self.onmessage = function (e) {\n" +
    "  const d = e.data || {};\n" +
    "  try {\n" +
    "    const enc = new lamejs.Mp3Encoder(1, d.sampleRate, 128);\n" +
    "    const pcm = new Int16Array(d.pcm);\n" +
    "    const out = [];\n" +
    "    const BLOCK = 1152;\n" +
    "    for (let i = 0; i < pcm.length; i += BLOCK) {\n" +
    "      const part = enc.encodeBuffer(pcm.subarray(i, i + BLOCK));\n" +
    "      if (part.length) out.push(part);\n" +
    "    }\n" +
    "    const end = enc.flush();\n" +
    "    if (end.length) out.push(end);\n" +
    "    postMessage({ id: d.id, ok: true, parts: out }, out.map((x) => x.buffer));\n" +
    "  } catch (err) {\n" +
    "    postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) });\n" +
    "  }\n" +
    "};\n";
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  w.onmessage = (e) => {
    const d = (e && e.data) || {};
    const r = _mp3Waiters.get(d.id);
    if (!r) return;
    _mp3Waiters.delete(d.id);
    if (d.ok) r.resolve(new Blob(d.parts, { type: "audio/mp3" }));
    else r.reject(new Error("paradee11: mp3 encode failed: " + d.error));
    _mp3Pump();
  };
  _mp3Worker = { worker: w, busy: false, queue: [] };
  return _mp3Worker;
}
function _mp3Pump() {
  const m = _mp3Worker;
  if (!m || m.busy) return;
  const job = m.queue.shift();
  if (!job) return;
  m.busy = true;
  const id = _mp3Id++;
  _mp3Waiters.set(id, {
    resolve: (b) => { m.busy = false; job.resolve(b); _mp3Pump(); },
    reject: (e) => { m.busy = false; job.reject(e); _mp3Pump(); },
  });
  m.worker.postMessage({ id, pcm: job.pcm.buffer, sampleRate: job.sampleRate }, [job.pcm.buffer]);
}

export async function floatToMp3Blob(audio, sampleRate, lameUrl) {
  const int16 = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const s = Math.max(-1, Math.min(1, audio[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  mp3Worker(lameUrl || PARADEE11_URLS.lame);
  return new Promise((resolve, reject) => {
    _mp3Worker.queue.push({ pcm: int16, sampleRate, resolve, reject });
    _mp3Pump();
  });
}

// --- pool + public API ----------------------------------------------------------
export async function createParadee(opts) {
  opts = opts || {};
  const urls = Object.assign({}, PARADEE11_URLS, opts.urls || {});
  const bundleUrl = opts.bundleUrl || urls.bundle;
  if (!bundleUrl) {
    throw new Error("paradee11: no bundle URL — pass { bundleUrl }");
  }
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  const maxWorkers = Math.max(1, opts.maxWorkers === "auto" || opts.maxWorkers == null
    ? defaultWorkerCount(cores)
    : Math.min(16, Math.floor(opts.maxWorkers)));
  const onProgress = opts.onProgress || null;
  const prog = (phase, progress) => { try { onProgress && onProgress({ phase, progress }); } catch (e) {} };

  // 1) Bundle: one download, sliced into blob URLs for every worker.
  prog("bundle", 0);
  const bundle = await loadBundle(bundleUrl, (u) => prog("bundle", u.progress));
  // 2) Pre-warm the workers' three static JS imports on this thread, so the
  // pool burst resolves from HTTP cache instead of downloading 16x.
  prog("js", 0);
  await Promise.all([urls.ort, urls.kokoro, urls.transformers].map((u) =>
    import(/* @vite-ignore */ u).catch((e) => console.warn("paradee11: js pre-warm failed (workers fetch directly):", e))
  ));
  prog("js", 1);

  // 3) Workers.
  const src = workerSource(urls);
  const workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const workers = [];
  const params = {
    modelUrl: bundle.modelUrl,
    fallbackInt8: (opts.fallbackModelUrl || null),
    tokenizerJson: bundle.tokenizerJson,
    ortMjsUrl: bundle.ortMjsUrl,
    ortWasmUrl: bundle.ortWasmUrl,
  };
  prog("workers", 0);
  const spawn = (i) => new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    const w = { worker, busy: false, ready: false, dead: false, current: null };
    workers.push(w);
    const to = setTimeout(() => reject(new Error("paradee11: worker " + i + " init timeout")), 120000);
    worker.onmessage = (e) => {
      const d = e.data || {};
      if (!w.ready) {
        if (d.type === "ready") {
          clearTimeout(to);
          w.ready = true;
          w.busy = false;
          worker.onmessage = (ev) => onWorkerMessage(w, ev);
          resolve(w);
        } else if (d.type === "error") {
          clearTimeout(to);
          w.dead = true;
          reject(new Error("paradee11: worker init failed: " + d.error));
        }
        return;
      }
      onWorkerMessage(w, e);
    };
    worker.onerror = (e) => {
      w.dead = true;
      if (!w.ready) { clearTimeout(to); reject(new Error("paradee11: worker error: " + ((e && e.message) || e))); }
      else if (w.current) { w.current.reject(new Error("paradee11: worker error")); w.current = null; w.busy = false; pump(); }
    };
    worker.postMessage({ type: "init", params });
  });
  for (let i = 0; i < maxWorkers; i++) prog("workers", i / maxWorkers);
  await Promise.all(Array.from({ length: maxWorkers }, (_, i) => spawn(i)));
  URL.revokeObjectURL(workerUrl);
  prog("workers", 1);

  // 4) Dispatch queue.
  const pending = [];
  function onWorkerMessage(w, e) {
    const job = w.current;
    const d = (e && e.data) || {};
    w.current = null;
    w.busy = false;
    if (!job) { pump(); return; }
    if (d.type === "chunk") job.resolve({ audio: new Float32Array(d.audio), sampleRate: d.sampleRate || PARADEE11_SAMPLE_RATE });
    else job.reject(new Error("paradee11: synthesis failed: " + (d.error || "unknown")));
    pump();
  }
  function pump() {
    while (pending.length) {
      const w = workers.find((x) => x.ready && !x.busy && !x.dead);
      if (!w) return;
      const job = pending.shift();
      if (job.signal && job.signal.aborted) { job.reject(new DOMException("aborted", "AbortError")); continue; }
      w.busy = true;
      w.current = job;
      w.worker.postMessage({
        type: "process",
        index: job.index,
        text: job.text,
        isStartOfParagraph: !!job.isStartOfParagraph,
        paragraphPause: true,
      });
    }
  }
  function enqueue(textData, signal, index) {
    return new Promise((resolve, reject) => {
      pending.push({ text: textData.text, isStartOfParagraph: textData.isStartOfParagraph, signal: signal || null, index: index || 0, resolve, reject });
      pump();
    });
  }

  let lameUrl = urls.lame;
  // Shared chunk runner: synthesizes every chunk across the pool (at most one
  // in-flight job per worker), calling onDone(index, {audio, sampleRate}) in
  // *completion* order as each chunk finishes. Chunks are the model's hard
  // limit made explicit: the text side has 512 positions minus 2 pads, so
  // anything longer MUST be split (the tokenizer silently truncates past 512
  // — see MAX_PHONEMES in paradee's own tts.py). Result order is restored by
  // the caller via the index.
  async function runChunked(chunks, signal, onDone) {
    let next = 0;
    const runOne = async () => {
      while (next < chunks.length) {
        if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
        const i = next++;
        const r = await enqueue(chunks[i], signal, i);
        if (onDone) await onDone(i, r);
      }
    };
    const runners = Array.from({ length: Math.min(workers.length, chunks.length) }, runOne);
    await Promise.all(runners);
  }
  function concatAudio(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Float32Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  const api = {
    workers: workers.length,
    bundleBytes: bundle.bytes,
    sampleRate: PARADEE11_SAMPLE_RATE,
    voiceName: PARADEE11_VOICE_NAME,
    // Single utterance -> raw Float32Array @24kHz. Any length: long text is
    // sentence-chunked across the pool and concatenated in chunk order.
    async sayRaw(text, opt) {
      const o = opt || {};
      const chunks = splitTextIntoChunks(String(text));
      if (chunks.length <= 1) {
        return enqueue(chunks.length ? chunks[0] : { text: "", isStartOfParagraph: false }, o.signal, 0);
      }
      const parts = new Array(chunks.length);
      await runChunked(chunks, o.signal, async (i, r) => { parts[i] = r.audio; });
      return { audio: concatAudio(parts), sampleRate: PARADEE11_SAMPLE_RATE };
    },
    // Single utterance -> WAV Blob. Any length (built on sayRaw).
    async sayWav(text, opt) {
      const r = await api.sayRaw(text, opt);
      return floatToWavBlob(r.audio, r.sampleRate);
    },
    // Text -> one combined MP3 Blob (CBR 128k mono). Any length: short text
    // takes the single-inference fast path, long text is chunked across the
    // pool, concatenated in order, and encoded once. Pass onChunk to stream
    // per-chunk MP3s as they finish (completion order): onChunk(mp3, i, total).
    async say(text, opt) {
      const o = opt || {};
      const chunks = splitTextIntoChunks(String(text));
      if (chunks.length <= 1) {
        const r = await enqueue(chunks.length ? chunks[0] : { text: "", isStartOfParagraph: false }, o.signal, 0);
        const mp3 = await floatToMp3Blob(r.audio, r.sampleRate, lameUrl);
        try { if (o.onChunk) await o.onChunk(mp3, 0, 1); } catch (e) {}
        if (o && o.returnChunks) return { blob: mp3, blobs: [mp3], count: 1 };
        return mp3;
      }
      const parts = new Array(chunks.length);
      await runChunked(chunks, o.signal, async (i, r) => {
        parts[i] = r.audio;
        if (o.onChunk) {
          const mp3 = await floatToMp3Blob(r.audio, r.sampleRate, lameUrl);
          try { await o.onChunk(mp3, i, chunks.length); } catch (e) {}
        }
      });
      const mp3 = await floatToMp3Blob(concatAudio(parts), PARADEE11_SAMPLE_RATE, lameUrl);
      if (o && o.returnChunks) {
        const blobs = await Promise.all(parts.map((p) => floatToMp3Blob(p, PARADEE11_SAMPLE_RATE, lameUrl)));
        return { blob: mp3, blobs, count: chunks.length };
      }
      return mp3;
    },
    // Legacy alias: say() with per-chunk blobs returned.
    // onChunk(mp3Blob, index, total) fires as each chunk finishes.
    // Returns { blob, blobs: [mp3Blob...], count } — blobs AND the combined
    // blob, both in chunk order. Prefer say(), which handles long text alone.
    async sayLong(text, opt) {
      const o = Object.assign({}, opt, { returnChunks: true });
      const r = await api.say(text, o);
      // say() with returnChunks always returns the object form, even for a
      // single chunk — normalize so sayLong's shape never varies.
      if (r && r.blob) return r;
      return { blob: r, blobs: [r], count: 1 };
    },
    close() {
      for (const w of workers) { try { w.worker.terminate(); } catch (e) {} }
      workers.length = 0;
      pending.length = 0;
      if (_mp3Worker) { try { _mp3Worker.worker.terminate(); } catch (e) {} _mp3Worker = null; }
    },
  };
  return api;
}

