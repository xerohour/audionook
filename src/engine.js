// ===========================================================================
// engine.js — in-browser text-to-speech (kokoro-js) engine.
//
// IMPORTANT: the WebGPU handling below (self-test + fallbacks + the worker's
// device selection loop + the frequency-content checks) was discovered by
// painful trial-and-error on real, buggy devices. DO NOT "simplify" it.
// See src/README.md for the long-form explanation.
// ===========================================================================

import { wav16ToMp3Blob, cpuBudget, computeMp3PoolSize } from "./audio.js";
import * as storage from "./storage.js";
import {
  engineForVoice, toMisaki, computeParadeePool, computeTitlPool, computeParadee11Pool, loadParadeeTokenizerJson,
  PARADEE_MODEL_URL_INT8, PARADEE_MODEL_URL_FP32, PARADEE_TOKENIZER_URL,
  TITL_MODEL_URL_INT8, TITL_MODEL_URL_FP32,
  PARADEE11_MODEL_URL_INT8, PARADEE11_MODEL_URL_FP32,
  PARADEE_ORT_URL, PARADEE_ORT_WASM_PATHS, lightModelBlobUrl,
  loadParadee11Bundle, warmLightJsCache,
} from "./paradee.js";

// Synthesised audio is cached in the shared storage layer; chunks are keyed by
// (voice, text) so a re-listen (or a re-shared book) costs nothing to re-render.
const chunkCache = storage.folder("chunkCache");
const chunkCacheMeta = storage.folder("chunkCacheMeta");

// ---------------------------------------------------------------------------
// Peer chunk sharing. When a chunk isn't cached on this device, we ask a synced
// peer for it before spending this device's CPU (and battery) re-synthesising
// it — the big win for a low-end phone that would otherwise grind through a
// whole book the user already generated on their PC. app.js wires the fetcher to
// the Device-sync engine; it is null when sync isn't set up, so the normal path
// is untouched. The fetcher bounds its own wait and resolves null when no peer
// can help, so it can never stall synthesis.
let peerChunkFetcher = null;
// Optional predicate telling us whether a peer is currently reachable. Prefetch
// uses it so that a linked-but-offline group doesn't spend the peer broker's
// per-batch 1.5 s "wait for a peer" timeout across an entire book; the local
// cache is still consulted (and `kickPrefetch` re-arms everything when a peer
// does appear). `_warm`/`_dispatch` deliberately do NOT gate on it: a near chunk
// is worth waiting briefly for, and it is where the low-powered-device win is.
let peerChunkAvailable = null;
export function setChunkFetcher(fn, isAvailable) {
  peerChunkFetcher = typeof fn === "function" ? fn : null;
  peerChunkAvailable = typeof isAvailable === "function" ? isAvailable : null;
}

// How many chunks we'll try to resolve from the cache/a peer at once while
// warming a book up (see TTSEngine._warm) and while prefetching it (see
// TTSEngine._prefetch). Kept modest so a phone doesn't open dozens of
// simultaneous requests against a peer.
const WARM_MAX = 12;
const PREFETCH_MAX = 12;

// The *delivery* window: `_warm` only pulls/reads chunks this close to the
// playhead, hands them to the player, and treats a miss inside it as the signal
// to bring the worker pool up. Keeping it small bounds both the work done on
// each setFocus and how much audio the player holds in memory at once. Once a
// worker pool exists the workers themselves churn through the whole queue, so
// this window only governs the cache/peer path.
const WARM_AHEAD = 20;
const WARM_BEHIND = 2;

// The *prefetch* window: how far from the playhead the background prefetch will
// resolve chunks into the LOCAL chunk cache from the cache itself or a linked
// peer. Both default to Infinity — the whole book — so a device can mirror a
// book that was generated elsewhere in one go and then play it back without
// depending on the other machine still being online. Set finite values (e.g. 20
// and 2, matching WARM_AHEAD/WARM_BEHIND) to restore the old lazy,
// near-the-playhead behaviour; see TTSEngine.setPrefetchWindow.
const DEFAULT_PREFETCH_AHEAD = Infinity;
const DEFAULT_PREFETCH_BEHIND = Infinity;

// Used by the Device-sync layer to serve a cached chunk to a peer (and to store
// one it fetched). The cache lives here, so the accessors do too.
export async function getCachedChunk(key) {
  try { return (await chunkCache.get(key)) || null; } catch (e) { return null; }
}
export async function putCachedChunk(key, blob) {
  if (!blob || !key) return;
  try {
    await chunkCacheMeta.set(key, { time: Date.now(), size: blob.size });
    await chunkCache.set(key, blob);
  } catch (e) { console.warn("chunk cache write failed:", e); }
}

// NOTE: `?target=es2022` with NO `?bundle` is deliberate. Without `?bundle`,
// esm.sh serves kokoro-js and @huggingface/transformers as separate modules, and
// kokoro-js imports the *same* transformers module instance that we import
// below. That lets us set `env.backends.onnx.wasm.numThreads` on the shared ORT
// env and have kokoro-js's model session honour it. With `?bundle`, transformers
// is inlined inside an IIFE closure and its env is unreachable, so every session
// silently used ORT's default (min(4, hw/2)) threads — which starves big
// machines and oversubscribes small ones. See src/README.md ("wasm speedup").
// Vendored + patched (see src/kokoro-js.vendored.mjs): kokoro-js's voice loader
// checks `Object.hasOwn(fs, "readFile")` to pick node-vs-browser loading, but
// some esm.sh browser builds ship a throwing unenv fs stub, which makes the
// check true and breaks ALL voice loading. The vendored copy forces the fetch
// path. Resolved relative to this module so it works on any deploy subpath;
// blob-URL workers need the absolute URL, hence import.meta.url.
export const kokoroImportUrl = new URL('./kokoro-js.vendored.mjs', import.meta.url).href;
export const transformersEnvUrl = 'https://esm.sh/@huggingface/transformers@^3.5.1?target=es2022';


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

  

  // // NOTE: Ideally I'd use actual token length rather than character length. Also note, length of 390 is too big for kokoro-js@1.0.1, based on experience.
  // function splitTextIntoChunks(text, maxSize=300) {
  //   text = text.replace(/\r\n|\r/g, '\n');
  //   text = text.replace(/[“”]/g, '"');
  //   text = text.replace(/[‘’]/g, "'");
    
  //   let chunks = [];
  //   let start = 0;
  //   let lastDelimiter = -1; // sentence enders
  //   let lastSubDelimiter = -1; // e.g. comma, colon, semicolon, etc.
  //   let lastSpace = -1; // i.e. word delimiter
    
  //   // Helper to check if char at index is preceded by sentence ending punctuation
  //   const hasEndingPunctuation = (str, index) => {
  //     if (index <= 0) return false;
  //     return /[.!?"]/.test(str[index - 1]);
  //   };
  
  //   for(let i = 0; i < text.length; i++) {
  //     const char = text[i];
      
  //     // Track potential split points
  //     if(char === '\n' && hasEndingPunctuation(text, i)) {
  //       lastDelimiter = i;
  //     } else if(/[.!?"]/.test(char)) {
  //       lastDelimiter = i + 1;  // Include the delimiter in chunk
  //     } else if(/[,;:]/.test(char)) {
  //       lastSubDelimiter = i + 1;  // Include the delimiter in chunk
  //     } else if(char === " ") {
  //       lastSpace = i + 1;
  //     }
      
  //     let isEndOfParagraph = (text[i] === "\n" && text[i+1] === "\n");
      
  //     // Check if we need to create a new chunk.
  //     // NOTE: Currently kokoro doesn't do well with pausing at new paragraphs, so we break the chunk at \n\n so we can add the pause manually.
  //     if(i - start >= maxSize || isEndOfParagraph) {
  //       let isStartOfParagraph = false;
        
  //       // require double-newline for paragraph else e.g. each line of a poem is treated as a paragraph
  //       if(text[start] === "\n" && (text[start-1] === "\n" || text[start+1] === "\n")) {
  //         isStartOfParagraph = true;
  //       }
        
  //       if(lastDelimiter > start) {
  //         chunks.push({isStartOfParagraph, text:text.slice(start, lastDelimiter).trim()});
  //         start = lastDelimiter;
  //         i = lastDelimiter;  // Resume from last delimiter
  //       } else if(lastSubDelimiter > start) {
  //         chunks.push({isStartOfParagraph, text:text.slice(start, lastSubDelimiter).trim()});
  //         start = lastSubDelimiter;
  //         i = lastSubDelimiter;  // Resume from last sub-delimiter
  //       } else if(lastSpace > start) {
  //         chunks.push({isStartOfParagraph, text:text.slice(start, lastSpace).trim()});
  //         start = lastSpace;
  //         i = lastSpace;
  //       } else {
  //         // No delimiter found, force split at maxSize
  //         chunks.push({isStartOfParagraph, text:text.slice(start, i).trim()});
  //         start = i;
  //       }
  //       lastDelimiter = -1;
  //       lastSubDelimiter = -1;
  //       lastSpace = -1;
  //     }
  //   }
    
  //   // Add remaining text
  //   if(start < text.length && text.slice(start).trim()) {
  //     let isStartOfParagraph = false;
  //     if(text[start] === "\n" && (text[start-1] === "\n" || text[start+1] === "\n")) {
  //       isStartOfParagraph = true;
  //     }
  //     chunks.push({isStartOfParagraph, text:text.slice(start).trim()});
  //   }
  //   chunks = chunks.filter(c => c.text.trim());
  //   console.debug("splitTextIntoChunks chunks:", chunks);
  //   return chunks;
  // }

  // Web Worker code as a string
  const WEBGPU_SELFTEST_ATOL = 1e-4;
  const WEBGPU_SELFTEST_RTOL = 1e-3;

  async function runWebgpuSelfTest() {
    const results = [];
    let getKernel, disposeSharedKernelRuntime;
    try {
      const mod = await import("https://esm.sh/@huggingface/kernels@0.0.1-preview.2");
      getKernel = mod.getKernel;
      disposeSharedKernelRuntime = mod.disposeSharedKernelRuntime;
    } catch(e) {
      console.warn("WebGPU self-test: could not load @huggingface/kernels, skipping:", e);
      return { passed: true, skipped: true, results };
    }

    const kernelCache = new Map();
    const loadKernel = (opId) => {
      if(!kernelCache.has(opId)) kernelCache.set(opId, getKernel(opId, { version: 1 }));
      return kernelCache.get(opId);
    };
    // deterministic pseudo-random inputs (LCG) so the same data is tested on every run
    const rand = (seed, n, lo = -1, hi = 1) => {
      const a = new Float32Array(n);
      let s = seed >>> 0 || 1;
      for(let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = lo + (s / 4294967296) * (hi - lo); }
      return a;
    };
    const compare = (actual, expected) => {
      let mismatches = 0, maxAbs = 0, firstBadIndex = -1;
      for(let i = 0; i < expected.length; i++) {
        const abs = Math.abs(actual[i] - expected[i]);
        if(abs > maxAbs) maxAbs = abs;
        if(abs > WEBGPU_SELFTEST_ATOL + WEBGPU_SELFTEST_RTOL * Math.abs(expected[i])) {
          mismatches++;
          if(firstBadIndex < 0) firstBadIndex = i;
        }
      }
      return { mismatches, maxAbs, firstBadIndex };
    };
    const matmulRef = (a, M, K, b, N) => {
      const y = new Float32Array(M * N);
      for(let i = 0; i < M; i++) {
        for(let j = 0; j < N; j++) {
          let sum = 0;
          for(let k = 0; k < K; k++) sum += a[i * K + k] * b[k * N + j];
          y[i * N + j] = sum;
        }
      }
      return y;
    };
    const matmulBatchedRef = (a, B, M, K, b, N) => {
      const y = new Float32Array(B * M * N);
      for(let t = 0; t < B; t++) {
        y.set(matmulRef(a.subarray(t * M * K, (t + 1) * M * K), M, K, b.subarray(t * K * N, (t + 1) * K * N), N), t * M * N);
      }
      return y;
    };
    const layerNormRef = (x, rows, H, scale, bias, epsilon) => {
      const y = new Float32Array(rows * H);
      for(let r = 0; r < rows; r++) {
        let mean = 0;
        for(let j = 0; j < H; j++) mean += x[r * H + j];
        mean /= H;
        let variance = 0;
        for(let j = 0; j < H; j++) variance += (x[r * H + j] - mean) ** 2;
        variance /= H;
        const invStdDev = 1 / Math.sqrt(variance + epsilon);
        for(let j = 0; j < H; j++) y[r * H + j] = (x[r * H + j] - mean) * invStdDev * scale[j] + bias[j];
      }
      return y;
    };

    const runProbe = async (name, fn) => {
      try {
        results.push({ name, ...(await fn()) });
      } catch(e) {
        // A thrown error is ambiguous (network, unsupported feature, ...) so don't fail
        // the device on it - only a numerically wrong result counts as a failure.
        results.push({ name, error: String((e && e.message) || e) });
      }
    };

    // --- ai.onnx.MatMul (the workhorse of every transformer) ---
    await runProbe("MatMul [3,5]x[5,4] f32", async () => {
      const a = rand(1, 15), b = rand(2, 20);
      const { y } = await (await loadKernel("webgpu-kernels/ai.onnx.MatMul"))({ a: { data: a, shape: [3, 5] }, b: { data: b, shape: [5, 4] } });
      return compare(y.data, matmulRef(a, 3, 5, b, 4));
    });
    await runProbe("MatMul [256,128]x[128,64] f32", async () => {
      const a = rand(3, 256 * 128), b = rand(4, 128 * 64);
      const { y } = await (await loadKernel("webgpu-kernels/ai.onnx.MatMul"))({ a: { data: a, shape: [256, 128] }, b: { data: b, shape: [128, 64] } });
      return compare(y.data, matmulRef(a, 256, 128, b, 64));
    });
    await runProbe("MatMul [64,1024]x[1024,64] f32 (large-K split)", async () => {
      const a = rand(5, 64 * 1024), b = rand(6, 1024 * 64);
      const { y } = await (await loadKernel("webgpu-kernels/ai.onnx.MatMul"))({ a: { data: a, shape: [64, 1024] }, b: { data: b, shape: [1024, 64] } });
      return compare(y.data, matmulRef(a, 64, 1024, b, 64));
    });
    await runProbe("MatMul batched [2,64,128]x[2,128,64] f32", async () => {
      const a = rand(7, 2 * 64 * 128), b = rand(8, 2 * 128 * 64);
      const { y } = await (await loadKernel("webgpu-kernels/ai.onnx.MatMul"))({ a: { data: a, shape: [2, 64, 128] }, b: { data: b, shape: [2, 128, 64] } });
      return compare(y.data, matmulBatchedRef(a, 2, 64, 128, b, 64));
    });

    // --- ai.onnx.LayerNormalization ---
    await runProbe("LayerNormalization [2,512] f32", async () => {
      const H = 512, epsilon = 1e-5;
      const x = rand(9, 2 * H), scale = rand(10, H), bias = rand(11, H);
      const { y } = await (await loadKernel("webgpu-kernels/ai.onnx.LayerNormalization"))(
        { x: { data: x, shape: [2, H] }, scale: { data: scale, shape: [H] }, b: { data: bias, shape: [H] } },
        { attrs: { axis: -1, epsilon } }
      );
      return compare(y.data, layerNormRef(x, 2, H, scale, bias, epsilon));
    });
    await runProbe("LayerNormalization [8,2048] f32", async () => {
      const H = 2048, epsilon = 1e-5;
      const x = rand(12, 8 * H), scale = rand(13, H), bias = rand(14, H);
      const { y } = await (await loadKernel("webgpu-kernels/ai.onnx.LayerNormalization"))(
        { x: { data: x, shape: [8, H] }, scale: { data: scale, shape: [H] }, b: { data: bias, shape: [H] } },
        { attrs: { axis: -1, epsilon } }
      );
      return compare(y.data, layerNormRef(x, 8, H, scale, bias, epsilon));
    });

    // --- ai.onnx.Transpose ---
    await runProbe("Transpose [3,4,5] perm [1,2,0] f32", async () => {
      const x = rand(15, 60);
      const { y } = await (await loadKernel("webgpu-kernels/ai.onnx.Transpose"))(
        { x: { data: x, shape: [3, 4, 5] } },
        { attrs: { perm: [1, 2, 0] }, outputs: { y: { shape: [4, 5, 3], dtype: "float32" } } }
      );
      const expected = new Float32Array(60);
      for(let i = 0; i < 3; i++) for(let j = 0; j < 4; j++) for(let k = 0; k < 5; k++) expected[j * 15 + k * 3 + i] = x[i * 20 + j * 5 + k];
      return compare(y.data, expected);
    });
    await runProbe("Transpose [64,128] perm [1,0] f32", async () => {
      const x = rand(16, 64 * 128);
      const { y } = await (await loadKernel("webgpu-kernels/ai.onnx.Transpose"))(
        { x: { data: x, shape: [64, 128] } },
        { attrs: { perm: [1, 0] }, outputs: { y: { shape: [128, 64], dtype: "float32" } } }
      );
      const expected = new Float32Array(64 * 128);
      for(let i = 0; i < 64; i++) for(let j = 0; j < 128; j++) expected[j * 64 + i] = x[i * 128 + j];
      return compare(y.data, expected);
    });

    // --- ai.onnx.Log (used by the log-mel front-end of audio models) ---
    await runProbe("Log [256] f32", async () => {
      const x = rand(17, 256, 0.01, 10);
      const { y } = await (await loadKernel("webgpu-kernels/ai.onnx.Log"))({ x: { data: x, shape: [256] } });
      return compare(y.data, Float32Array.from(x, Math.log));
    });

    try { if(disposeSharedKernelRuntime) await disposeSharedKernelRuntime(); } catch(e) {}

    const failed = results.filter(r => r.mismatches > 0);
    return { passed: failed.length === 0, skipped: false, results, failed };
  }
  const workerCode = `
    import { KokoroTTS } from '${kokoroImportUrl}';
    // Imported so we can reach the SAME transformers module instance kokoro-js
    // uses internally and force the ORT wasm session thread count (see the
    // comment on kokoroImportUrl above).
    import { env, PreTrainedTokenizer, RawAudio } from '${transformersEnvUrl}';
    // Paradee and Teacher-in-the-Loop (the Light voices) run through their own
    // onnxruntime-web copy, so Kokoro's session settings are untouched.
    // Constants injected from src/paradee.js at module load — the single source
    // of truth, do not hardcode.
    import * as paradeeOrt from '${PARADEE_ORT_URL}';
    const PARADEE_INT8_URL = '${PARADEE_MODEL_URL_INT8}';
    const PARADEE_FP32_URL = '${PARADEE_MODEL_URL_FP32}';
    const TITL_INT8_URL = '${TITL_MODEL_URL_INT8}';
    const TITL_FP32_URL = '${TITL_MODEL_URL_FP32}';
    const PARADEE11_INT8_URL = '${PARADEE11_MODEL_URL_INT8}';
    const PARADEE11_FP32_URL = '${PARADEE11_MODEL_URL_FP32}';
    const PARADEE_TOKENIZER_REMOTE_URL = '${PARADEE_TOKENIZER_URL}';
    const PARADEE_ORT_WASM_PATHS = '${PARADEE_ORT_WASM_PATHS}';
    // eSpeak -> misaki phoneme conversion (Paradee only learned misaki's
    // spellings; raw eSpeak phonemes mumble). Function source embedded from
    // src/paradee.js — keep that function dependency-free and self-contained.
    const toMisaki = (${toMisaki.toString()});

    // To detect buggy WebGPU:
    function detectHighFrequencyContent({
      audioBuffer,
      sampleRate,
      thresholdFrequency = 8000,
    }) {
      const N = audioBuffer.length;
      if (N === 0) {
        return {
          mostProminentFrequency: 0,
          hasHighFrequencyEnergy: false
        };
      }
    
      // 1) Find the next power of two >= N
      const fftSize = nextPowerOf2(N);
      const real = new Float32Array(fftSize);
      const imag = new Float32Array(fftSize);
    
      // 2) (Optional) Apply a window + copy into real part
      //    Or, just copy directly. Example with a Hann window:
      for (let i = 0; i < N; i++) {
        const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
        real[i] = audioBuffer[i] * window;
      }
      // rest is already zero by default
    
      // 3) Run in-place FFT on (real, imag)
      fftInPlace(real, imag);
    
      // 4) Compute magnitude and detect
      let maxMagnitude = 0;
      let maxIndex = 0;
      let highFreqSum = 0;
    
      const freqResolution = sampleRate / fftSize;
      const halfSize = fftSize >> 1; // same as fftSize / 2
    
      for (let i = 0; i < halfSize; i++) {
        const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        if (mag > maxMagnitude) {
          maxMagnitude = mag;
          maxIndex = i;
        }
        // Accumulate high-frequency energy
        const freq = i * freqResolution;
        if (freq >= thresholdFrequency) {
          highFreqSum += mag;
        }
      }
    
      const mostProminentFrequency = maxIndex * freqResolution;
    
      return {
        mostProminentFrequency,
        highFreqFactor: highFreqSum/halfSize,
      };
    }
    
    // Helper: next power of two
    function nextPowerOf2(x) {
      // If already power of 2, just return x
      // Otherwise, shift up
      let p = 1;
      while (p < x) {
        p <<= 1;
      }
      return p;
    }
    
    /**
     * In-place FFT (Cooley-Tukey) for power-of-two sizes.
     * real and imag are Float32Arrays. Mutates them in place.
     */
    function fftInPlace(real, imag) {
      const n = real.length;
    
      // --- 1) Bit-reversal
      let j = 0;
      for (let i = 0; i < n - 1; i++) {
        if (i < j) {
          [real[i], real[j]] = [real[j], real[i]];
          [imag[i], imag[j]] = [imag[j], imag[i]];
        }
        let m = n >> 1;
        while (j >= m) {
          j -= m;
          m >>= 1;
        }
        j += m;
      }
    
      // --- 2) Danielson-Lanczos
      for (let len = 2; len <= n; len <<= 1) {
        const halfLen = len >> 1;
        const theta = -2.0 * Math.PI / len;
        const wpr = Math.cos(theta);
        const wpi = Math.sin(theta);
    
        for (let start = 0; start < n; start += len) {
          let wr = 1;
          let wi = 0;
          for (let k = 0; k < halfLen; k++) {
            const i = start + k;
            const j = i + halfLen;
            const realj = real[j];
            const imagj = imag[j];
    
            // "Butterfly" operations
            const tempr = wr * realj - wi * imagj;
            const tempi = wr * imagj + wi * realj;
            real[j] = real[i] - tempr;
            imag[j] = imag[i] - tempi;
            real[i] += tempr;
            imag[i] += tempi;
    
            // Update the twiddle factors
            const wtemp = wr;
            wr = wtemp * wpr - wi * wpi;
            wi = wtemp * wpi + wi * wpr;
          }
        }
      }
    }

    
    let tts;
    let ttsEngine = 'kokoro';

    // The Light voices: small single-voice Kokoro distills. Each reuses kokoro-js for text ->
    // phonemes -> token ids (with the eSpeak output converted to misaki
    // spellings they were trained on) and swap the model call for their own
    // ONNX graph — the same recipe as the Chickadee extension's light voice.
    // Single-threaded wasm is plenty (~18-20x realtime) and needs no
    // SharedArrayBuffer/cross-origin isolation. The Light models share the
    // phoneme vocabulary and input/output layout, so one init path serves all.
    async function initParadee(params={}) {
      const engineUrls = {
        titl: [TITL_INT8_URL, TITL_FP32_URL],
        paradee11: [PARADEE11_INT8_URL, PARADEE11_FP32_URL],
      };
      const urls = engineUrls[params.engine] || [PARADEE_INT8_URL, PARADEE_FP32_URL];
      // Single-file bundle: the main thread downloaded src/paradee11-rt.bundle
      // ONCE and hands every worker memory-served blob: URLs for the model AND
      // the ORT runtime (glue + wasm). Remote URLs stay as fallback (blob
      // fetch throws -> next entry; missing runtime blobs -> dist default).
      if (params.modelBlobUrl) urls.unshift(params.modelBlobUrl);
      const label = params.engine || 'paradee';
      let rtSource = 'dist';
      try {
        if (params.ortMjsUrl || params.ortWasmUrl) {
          const wp = {};
          if (params.ortMjsUrl) wp.mjs = params.ortMjsUrl;
          if (params.ortWasmUrl) wp.wasm = params.ortWasmUrl;
          paradeeOrt.env.wasm.wasmPaths = wp;
          rtSource = 'bundle';
        } else {
          paradeeOrt.env.wasm.wasmPaths = PARADEE_ORT_WASM_PATHS;
        }
      } catch(e) {}
      try { paradeeOrt.env.wasm.numThreads = 1; } catch(e) {}
      let tokJson = params.tokenizerJson || null;
      if (!tokJson) tokJson = await (await fetch(PARADEE_TOKENIZER_REMOTE_URL)).json();
      const tok = new PreTrainedTokenizer(tokJson, { model_max_length: 512, pad_token: '$', unk_token: '$' });
      const t = new KokoroTTS(null, (phonemes, opts) => tok(toMisaki(phonemes), opts));
      let session = null, lastErr = null, usedUrl = '';
      for (const url of urls) {
        try {
          session = await paradeeOrt.InferenceSession.create(url, { executionProviders: ['wasm'] });
          usedUrl = url;
          break;
        } catch(e) { lastErr = e; console.warn(label + ' load failed for ' + url + ', trying next:', e); }
      }
      console.debug(label + ' model source:', usedUrl.startsWith('blob:') ? 'shared memory blob' : usedUrl);
      console.debug(label + ' ort runtime:', rtSource);
      if (!session) throw lastErr || new Error(label + ' load failed');
      t.generate_from_ids = async (ids) => {
        const out = await session.run({
          input_ids: new paradeeOrt.Tensor('int64', ids.data, ids.dims),
          speed: new paradeeOrt.Tensor('float32', new Float32Array([1]), [1]),
        });
        const wv = out.waveform || out[Object.keys(out)[0]];
        return new RawAudio(wv.data, 24000);
      };
      return { tts: t, usedUrl, rtSource };
    }

    async function initTTS(params={}) {
      if (params.engine === 'paradee' || params.engine === 'titl' || params.engine === 'paradee11') {
        ttsEngine = params.engine;
        const pr = await initParadee(params);
        tts = pr.tts;
        postMessage({ type: 'init', status: 'ready', deviceUsed: params.engine, modelSource: pr.usedUrl.startsWith('blob:') ? 'blob' : 'remote', rtSource: pr.rtSource });
        return;
      }
      ttsEngine = 'kokoro';
      let availableDevices = ["wasm"];

      if(params.allowWebGpu) {
        let webgpuIsAvailable = navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() =>{}));
        // IMPORTANT: webgpu must come *before* wasm, because we have a 'continue' statement if it "works" but it's broken.
        if(webgpuIsAvailable) availableDevices.unshift("webgpu");
      }

      // Force the ORT wasm thread count for THIS session. The engine spawns many
      // wasm workers (one ORT session each) and sets numThreads=1/2/4 per worker
      // depending on the machine (see TTSEngine.init) — that combination is what
      // gives the multi-× speedup over ORT's default min(4, hw/2).
      if(params.numThreads) {
        try { env.backends.onnx.wasm.numThreads = params.numThreads; } catch(e) { console.warn("could not set numThreads:", e); }
      }
      env.allowLocalModels = false;
      console.debug("initTTS", { availableDevices, numThreads: env.backends.onnx.wasm.numThreads, simd: env.backends.onnx.wasm.simd });
      
      let deviceUsed = "";
      for(let device of availableDevices) {
        try {
          tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-ONNX", {
            dtype: device === "webgpu" ? "fp32" : "q8",
            device,
            progress_callback: (data) => {
              if(data.status !== 'progress') return;
              postMessage({ type: 'init', status: 'loading', progress:data.progress });
            },          });

          // Ensure webgpu isn't broken. NOTE: we deliberately skip this probe on
          // wasm — running it on every worker costs an extra forward pass per
          // worker at startup and buys nothing (the wasm backend has no known
          // silent-corruption failure mode like the GPU one).
          if(device === "webgpu") {
            const audio = await tts.generate("Testing");
            console.debug("getting freq data...");
            let freqData = detectHighFrequencyContent({
              audioBuffer: audio.audio,
              sampleRate: audio.sampling_rate,
              thresholdFrequency: 3000,
            });
            console.debug('mostProminentFrequency:', freqData.mostProminentFrequency.toFixed(2), 'Hz');
            console.debug('highFreqFactor:', freqData.highFreqFactor);
  
            if(freqData.mostProminentFrequency > 3000) continue;
            if(freqData.mostProminentFrequency < 10) continue;
            // if(freqData.highFreqFactor > 10) continue;
          }
          
          deviceUsed = device;
          break;
        } catch(e) {
          console.error("Failed to init model on device:", device, e);
        }
      }
      postMessage({ type: 'init', status: 'ready', deviceUsed });
    }

    async function processChunk(textData, voice) {
      try {
        console.debug("processing:", JSON.stringify(textData));
        // The Light voices each speak one voice (af_heart, which they were
        // distilled from), so the requested voice is only a cache label —
        // always synthesize as heart.
        const v = ttsEngine === 'kokoro' ? voice : 'af_heart';
        const tGen0 = performance.now();
        const audio = await tts.generate(textData.text, { voice: v });
        const tGen1 = performance.now();
        if(textData.isStartOfParagraph) {
          let pauseSeconds = 0.1;
          pauseSeconds += 0.2*Math.min(1, textData.text.length/150); // max of +0.2 seconds depending on how long the chunk is
          let pauseSamples = new Array(Math.round(audio.sampling_rate*pauseSeconds)).fill(0);
          audio.audio = new Float32Array([...pauseSamples, ...audio.audio])
        }
        const wavBuffer = await audio.toWav();
        const tWav1 = performance.now();
        return { wavBuffer, tGen: tGen1 - tGen0, tWav: tWav1 - tGen1 };
      } catch (error) {
        throw new Error('Failed to process chunk: ' + error.message);
      }
    }

    self.onmessage = async function(e) {
      if (e.data.type === 'init') {
        await initTTS(e.data.params);
      } else if (e.data.type === 'process') {
        try {
          const r = await processChunk(e.data.textData, e.data.voice);
          postMessage({
            type: 'chunk',
            index: e.data.index,
            textData: e.data.textData,
            voice: e.data.voice,
            buffer: r.wavBuffer,
            timings: { gen: r.tGen, wav: r.tWav },
          });
        } catch (error) {
          postMessage({
            type: 'error',
            index: e.data.index,
            error: error.message
          });
        }
      }
    };
  `;

// ---------------------------------------------------------------------------
// TTSEngine — manages the Kokoro worker pool plus one pool per Light voice,
// with a prioritised queue shared across all.
//
// A worker holds exactly one model, so jobs are routed by voice (see
// engineForVoice in paradee.js). Each pool initialises lazily and only when
// actually needed, so a Light-voice book never downloads the 325 MB Kokoro
// model and vice versa.
//
// The queue is ordered by distance from `focus` (the playhead), so if the
// listener taps ahead in the text we synthesise THAT chunk next instead of
// grinding through the whole book from the start. Chunks are cached in
// kv-plugin (`v2:mp3:<voice>:<json>`) so replays and re-shares are instant.
// ---------------------------------------------------------------------------

export function cacheKeyFor(voice, textData) {
  return "v2:mp3:" + voice + ":" + JSON.stringify(textData);
}

// Bulk (non-focus) worker count cap. Each wasm worker keeps a full copy of the
// model in memory (~0.25-0.3 GB in practice), so this is as much a memory guard
// as a throughput one — 15 bulk workers is roughly 4.5 GB.
const MAX_BULK_WORKERS = 15;

function clampBulkWorkers(n) {
  n = Math.floor(n);
  if (!(n > 0)) return 0;
  if (n > MAX_BULK_WORKERS) return MAX_BULK_WORKERS;
  return n;
}

// HARD RULE (see cpuBudget in audio.js): TTS + MP3 workers combined never
// exceed half of navigator.hardwareConcurrency. The MP3 pool draws first
// (computeMp3PoolSize); the TTS pools share what is left. Past ~34 threads
// throughput plateaus anyway (memory bandwidth), so the ceiling costs nothing
// on big machines and keeps small ones responsive.
const THREAD_CAP = 34;

function threadBudget(cores) {
  return Math.max(1, Math.min(cpuBudget(cores) - computeMp3PoolSize(cores), THREAD_CAP));
}

// How many ORT threads each worker session gets, and how many bulk workers to
// spawn, given the machine.
//
// Measured on a 64-core / 32 GB machine: a pool of 15 bulk nt=2 workers plus one
// nt=4 "focus" worker sustains ~2.4x the throughput of the old 4xnt4 pool, while
// the focus worker keeps time-to-first-chunk close to the old behaviour. ORT's
// per-session threading has a large serial fraction, so many small-thread
// sessions beat a few big ones. `threadBudget` keeps TTS within its share of
// the half-cores background allowance (after the MP3 pool's draw).
//
// Without SharedArrayBuffer (which ORT's threaded wasm needs) every session is
// single-threaded, so we use nt=1 and one worker per available thread instead.
export function computePool(cores, threading) {
  const budget = threadBudget(cores);
  if (!threading) {
    return { focusNt: 1, bulkNt: 1, bulkWorkers: clampBulkWorkers(budget - 1) };
  }
  const focusNt = Math.min(4, budget);
  const bulkNt = cores >= 16 ? 2 : 1;
  return { focusNt, bulkNt, bulkWorkers: clampBulkWorkers(Math.floor((budget - focusNt) / bulkNt)) };
}

export class TTSEngine {
  constructor(opts = {}) {
    this.onInitProgress = opts.onInitProgress || (() => {});
    this.onReady = opts.onReady || (() => {});
    this.onDevice = opts.onDevice || (() => {});
    this.onChunk = opts.onChunk || (() => {});
    this.onChunkError = opts.onChunkError || (() => {});
    this.onNeedEngine = opts.onNeedEngine || (() => {});
    // Fired with {engine, rtf, avg} for every freshly synthesised chunk (never
    // for cache/peer hits). Lets the app notice an engine running below
    // realtime on the device and suggest the Light voice.
    this.onSpeed = opts.onSpeed || (() => {});
    this.allowWebGpu = opts.allowWebGpu !== false;
    this.hasWebGpu = false;
    this.gpuFailed = false;
    this.deviceUsed = null;
    this.webgpuSelfTest = { passed: true, skipped: true, results: [] };
    this.initialized = false;
    this.ready = false;
    this.workers = [];
    // One worker pool per engine. A worker holds exactly one model, so Kokoro
    // (325 MB), Paradee (9 MB) and TITL (9 MB) workers coexist and jobs are
    // routed by voice. Each pool initialises lazily — opening a Paradee book
    // never downloads Kokoro and vice versa.
    this.pools = {
      kokoro: { ready: false, promise: null, maxWorkers: 0, focusNt: 1, bulkNt: 1, nextIdx: 0 },
      paradee: { ready: false, promise: null, maxWorkers: 0, focusNt: 1, bulkNt: 1, nextIdx: 0 },
      titl: { ready: false, promise: null, maxWorkers: 0, focusNt: 1, bulkNt: 1, nextIdx: 0 },
      paradee11: { ready: false, promise: null, maxWorkers: 0, focusNt: 1, bulkNt: 1, nextIdx: 0 },
    };
    // Rolling measured synthesis speed (audio-seconds per wall-second) per
    // engine, newest last, capped below.
    this.rtfSamples = { kokoro: [], paradee: [], titl: [], paradee11: [] };
    this.jobs = new Map();     // index -> job for the current book
    this.pending = new Set();  // indices awaiting dispatch
    this.onceJobs = [];        // one-off jobs (voice previews) — always first
    // Release a TTS worker the moment its WAV arrives instead of holding it
    // through the MP3 encode + cache write (see _onWorkerMessage). `false`
    // restores the legacy hold-through-encode behavior; kept as a benchmark
    // switch and an emergency kill-switch, not a user setting.
    this._releaseEarly = true;
    this.focus = 0;
    this.voice = null;
    this.total = 0;
    // Bumped on every setBook (i.e. on every open / voice change). Every job is
    // stamped with it so results that arrive after the user has moved to another
    // book can be discarded — the player keys audio by index, so an old book's
    // chunk 0 landing on a new book's chunk 0 would play the wrong book.
    this._bookToken = 0;
    this._warmInFlight = 0;
    // Whole-book prefetch (see _prefetch). The cursors walk outward from the
    // playhead at the moment the book was opened.
    this.prefetchAhead = opts.prefetchAhead != null ? opts.prefetchAhead : DEFAULT_PREFETCH_AHEAD;
    this.prefetchBehind = opts.prefetchBehind != null ? opts.prefetchBehind : DEFAULT_PREFETCH_BEHIND;
    this._prefetchInFlight = 0;
    this._pfFocus = null;
    this._pfAhead = 0;
    this._pfBehind = -1;
    this._cacheTimer = null;
    this._workerUrl = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
  }

  get pendingCount() {
    return this.pending.size + this.onceJobs.length;
  }

  get busyCount() {
    return this.workers.filter((w) => w && w.busy && !w.dead).length;
  }

  get warmCount() {
    return this._warmInFlight;
  }

  // Chunks the background prefetch has confirmed in the LOCAL chunk cache but
  // not yet handed to the player. They are playable with no peer and no CPU, so
  // the player counts them as ready (this is what makes the buffered bar fill as
  // a whole book syncs in).
  get cachedCount() {
    let n = 0;
    for (const i of this.pending) { const j = this.jobs.get(i); if (j && j.cached) n++; }
    return n;
  }

  poolReady(engine) {
    const p = this.pools[engine];
    return !!(p && p.ready && this.workers.some((w) => w && w.engine === engine && w.ready && !w.dead));
  }

  idleWorker(engine) {
    return this.workers.find((x) => x && x.engine === engine && x.ready && !x.busy && !x.dead) || null;
  }

  avgRTF(engine) {
    const s = this.rtfSamples[engine] || [];
    if (!s.length) return 0;
    return s.reduce((a, b) => a + b, 0) / s.length;
  }

  _recordRTF(engine, rtf) {
    if (!(rtf > 0) || !isFinite(rtf)) return;
    const s = this.rtfSamples[engine] || (this.rtfSamples[engine] = []);
    s.push(rtf);
    if (s.length > 12) s.shift();
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    try { this.onSpeed({ engine, rtf, avg, samples: s.length }); } catch (e) {}
  }

  init(engine = "kokoro") {
    const pool = this.pools[engine];
    if (!pool) return Promise.resolve(false);
    if (pool.promise) return pool.promise;
    pool.promise = (async () => {
      if (engine === "paradee" || engine === "titl" || engine === "paradee11") return this._initLight(pool, engine);
      return this._initKokoro(pool);
    })();
    return pool.promise;
  }

  // Shared init for the Light voices (Paradee + Teacher-in-the-Loop + v1.1):
  // same 8M-param shape, same tokenizer, same single-threaded wasm recipe —
  // only the model bytes and the engine label differ.
  //
  // Single-download design (see paradee.js loadParadee11Bundle): the main
  // thread downloads src/paradee11-rt.bundle ONCE (JSEP-less ORT glue + wasm,
  // v1.1 model, tokenizer) and hands every worker memory-served blob: URLs,
  // so workers make ZERO runtime fetches. The only network per worker is its
  // three static JS imports, which are properly HTTP-cacheable — and those
  // are pre-warmed on the main thread below, so the 16-worker burst still
  // downloads them exactly once. Nothing downloads lazily at first
  // inference any more (the phonemizer is embedded in kokoro-js, the ORT
  // kernels ship in the one wasm file), so — unlike the old tail-gated
  // design — ALL workers spawn immediately: faster pool fill, no TTFA tax.
  // Every remote URL remains as fallback if the bundle is unreadable.
  async _initLight(pool, engine) {
    const cores = navigator.hardwareConcurrency || 4;
    const poolFn = { titl: computeTitlPool, paradee11: computeParadee11Pool }[engine] || computeParadeePool;
    pool.maxWorkers = poolFn(cores).maxWorkers;
    pool.focusNt = 1;
    pool.bulkNt = 1;
    console.debug(`TTS pool (${engine}):`, { cores, maxWorkers: pool.maxWorkers });
    this.onInitProgress({ phase: "load", progress: 0 });
    // One bundle download for all Light pools (single-flighted in paradee.js;
    // the runtime sections are shared — only paradee11 also takes the model).
    let bundle = null;
    try { bundle = await loadParadee11Bundle(); }
    catch (e) { console.warn(engine + " runtime bundle unreadable, workers will fetch remote:", e); }
    // The worker can't fetch the vendored tokenizer relatively (blob worker
    // has no base URL), so the main thread hands it over: from the bundle
    // when available, else the vendored copy (the worker falls back to the
    // HF-hosted copy if both are unreadable).
    let tokenizerJson = (bundle && bundle.tokenizerJson) || null;
    if (!tokenizerJson) {
      try { tokenizerJson = await loadParadeeTokenizerJson(); }
      catch (e) { console.warn(engine + " tokenizer vendored copy unreadable, worker will fetch remote:", e); }
    }
    // Model bytes: paradee11 takes them from the bundle; the other Light
    // voices keep their existing single-flight remote fetch (their models are
    // not in the bundle). Remote URLs stay as fallback either way.
    let modelBlobUrl = null;
    if (bundle && engine === "paradee11") {
      try { modelBlobUrl = bundle.modelUrl(); }
      catch (e) { console.warn(engine + " bundle model slice failed, workers will fetch remote:", e); }
    }
    if (!modelBlobUrl) {
      try { modelBlobUrl = await lightModelBlobUrl(engine); }
      catch (e) { console.warn(engine + " shared model fetch failed, workers will fetch remote:", e); }
    }
    const extra = {
      tokenizerJson,
      modelBlobUrl,
      ortMjsUrl: (bundle && bundle.ortMjsUrl) || null,
      ortWasmUrl: (bundle && bundle.ortWasmUrl) || null,
    };
    // Warm the HTTP cache for the workers' three static JS imports before the
    // burst, so 16 simultaneous imports resolve cached (see warmLightJsCache).
    try {
      await warmLightJsCache([PARADEE_ORT_URL, kokoroImportUrl, transformersEnvUrl]);
    } catch (e) {}
    await this._createWorker(engine, 1, extra);
    pool.ready = true;
    this.ready = true;
    this.onReady({
      engine,
      deviceUsed: this.deviceUsed,
      gpuFailed: this.gpuFailed,
      hasWebGpu: this.hasWebGpu,
      maxWorkers: pool.maxWorkers,
    });
    // No lazy assets remain (bundle + pre-warm + embedded phonemizer), so the
    // bulk workers spawn immediately — the old first-tail gate is gone.
    for (let i = 1; i < pool.maxWorkers; i++) {
      this._createWorker(engine, 1, extra).catch((e) => console.error(engine + " worker init:", e));
    }
    this._startCacheCleanup();
    return true;
  }

  async _initKokoro(pool) {
      this.hasWebGpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null)));

      let useGpu = false;
      if (this.hasWebGpu && this.allowWebGpu) {
        this.onInitProgress({ phase: "selftest" });
        this.webgpuSelfTest = await runWebgpuSelfTest();
        if (!this.webgpuSelfTest.passed) {
          console.warn("WebGPU correctness check FAILED — falling back to wasm. Failed probes:", this.webgpuSelfTest.failed);
          this.gpuFailed = true;
          this.allowWebGpu = false;
        } else {
          if (!this.webgpuSelfTest.skipped) {
            console.debug("WebGPU correctness check passed:", this.webgpuSelfTest.results);
          }
          useGpu = true;
        }
        window.webgpuSelfTestResult = this.webgpuSelfTest;
      }
      this.useGpu = useGpu;

      const cores = navigator.hardwareConcurrency || 4;
      // ORT's threaded wasm needs SharedArrayBuffer, which needs a
      // cross-origin-isolated context. If we don't have it, sessions are
      // single-threaded no matter what we ask for, so the pool is the only lever.
      const threading = !!self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
      this.threading = threading;

      if (useGpu) {
        // A single GPU worker is already far faster than several wasm workers,
        // and GPU contexts don't parallelise well across workers.
        pool.focusNt = 1;
        pool.bulkNt = 1;
        pool.maxWorkers = 1;
      } else {
        const computed = computePool(cores, threading);
        pool.focusNt = computed.focusNt;
        pool.bulkNt = computed.bulkNt;
        // Worker 0 is the "focus" worker: it gets more ORT threads and takes the
        // chunk nearest the playhead first (see _pump), which keeps
        // time-to-first-audio close to the old small-pool behaviour while the
        // bulk workers chew through the rest of the book in parallel.
        pool.maxWorkers = 1 + computed.bulkWorkers;
      }
      console.debug("TTS pool (kokoro):", { cores, threading, useGpu, focusNt: pool.focusNt, bulkNt: pool.bulkNt, maxWorkers: pool.maxWorkers });

      await this._createWorker("kokoro", pool.focusNt);
      pool.ready = true;
      this.ready = true;
      this.onReady({
        engine: "kokoro",
        deviceUsed: this.deviceUsed,
        gpuFailed: this.gpuFailed,
        hasWebGpu: this.hasWebGpu,
        maxWorkers: pool.maxWorkers,
      });
      // Worker 0 is ready and can start synthesising the playhead chunk while the
      // bulk workers load. Because worker 0 loads the model first, the bulk
      // workers hit the (transformers.js) Cache API instead of re-downloading it.
      for (let i = 1; i < pool.maxWorkers; i++) {
        this._createWorker("kokoro", pool.bulkNt).catch((e) => console.error("worker init:", e));
      }
      this._startCacheCleanup();
      return true;
  }

  _createWorker(engine, numThreads, extra = {}) {
    return new Promise((resolve) => {
      const worker = new Worker(this._workerUrl, { type: "module" });
      const pool = this.pools[engine];
      const index = pool ? pool.nextIdx++ : this.workers.length;
      const w = { worker, index, engine, numThreads, busy: true, ready: false, dead: false, currentJob: null };
      this.workers.push(w);
      worker.onmessage = (e) => {
        const data = e.data;
        if (!w.ready) {
          if (data.type === "init") {
            if (data.status === "loading") {
              // transformers.js reports 0..100; normalise to 0..1 for the UI.
              const p = typeof data.progress === "number" ? (data.progress > 1 ? data.progress / 100 : data.progress) : 0;
              this.onInitProgress({ phase: "load", progress: p });
            } else if (data.status === "ready") {
              w.ready = true;
              w.busy = false;
              if (data.modelSource) w.modelSource = data.modelSource;
              if (data.rtSource) w.rtSource = data.rtSource;
              if (!this.deviceUsed) this.deviceUsed = data.deviceUsed || "wasm";
              this.onDevice({ deviceUsed: data.deviceUsed, gpuFailed: this.gpuFailed, hasWebGpu: this.hasWebGpu });
              resolve(w);
              this._pump();
            }
          }
          return;
        }
        this._onWorkerMessage(w, data);
      };
      worker.onerror = (e) => {
        console.error("TTS worker error:", (e && e.message) || e);
        w.dead = true;
        w.busy = false;
        if (!w.ready) {
          w.ready = true;
          resolve(w);
        } else {
          this._failJob(w, w.currentJob, new Error((e && e.message) || "worker error"));
        }
      };
      worker.postMessage({ type: "init", params: { allowWebGpu: this.allowWebGpu, numThreads, engine, tokenizerJson: extra.tokenizerJson || null, modelBlobUrl: extra.modelBlobUrl || null, ortMjsUrl: extra.ortMjsUrl || null, ortWasmUrl: extra.ortWasmUrl || null } });
    });
  }

  _onWorkerMessage(w, data) {
    if (data.type === "chunk") {
      const job = w.currentJob;
      if (!job) return;
      // Benchmark switch: when false the worker is held busy through the MP3
      // encode + cache write below (the pre-detach behavior); when true it is
      // released immediately and the tail completes detached. The tail itself
      // is identical either way.
      const releaseEarly = this._releaseEarly !== false;
      if (releaseEarly) {
      // The worker's inference is done — the WAV buffer is fully in hand —
      // so release it BEFORE the MP3 encode below. The encode runs on a
      // separate MP3-worker pool and the cache write is async storage I/O;
      // holding the TTS worker through them idles ~570 ms of inference per
      // Light chunk for nothing. The job carries its book token, so the
      // detached tail can still discard stale work; _pump() immediately
      // hands the freed worker its next chunk.
      w.busy = false;
      w.currentJob = null;
      this._pump();
      }
      (async () => {
        try {
          const T = data.timings || {};
          // Stage timings (ms) for pipeline profiling: worker inference+vocoder
          // (gen), worker WAV encode (wav), main-thread WAV decode (join),
          // main-thread WAV re-encode (rewav), MP3 round-trip (mp3) and the
          // actual lamejs encode inside the MP3 worker (mp3enc). Stored on the
          // job for the profiler; otherwise ignored.
          const tJoin0 = performance.now();
          // The TTS worker's buffer is a WAV (32-bit float from RawAudio.toWav —
          // that is why the old WAV->AudioBuffer->WAV round-trip existed: the
          // MP3 worker's parser only handled PCM16. It now converts float32
          // itself). The buffer goes straight to the MP3 pool — no main-thread
          // decode/re-encode round-trip. Duration comes from the WAV header
          // (data bytes / byte rate), not a decode.
          const wavView = new DataView(data.buffer);
          const wavRate = wavView.getUint32(24, true) || 24000;
          const wavCh = wavView.getUint16(22, true) || 1;
          const wavBits = wavView.getUint16(34, true) || 16;
          const wavDataBytes = wavView.getUint32(40, true) || 0;
          const durationSec = wavDataBytes / (wavRate * wavCh * (wavBits / 8));
          const tJoin1 = performance.now();
          // Measured synthesis speed for this chunk (audio-seconds per
          // wall-second, synthesis only — queue wait excluded). Cache/peer
          // hits never reach a worker, so everything measured here is real
          // inference on this device.
          if (job.t0) {
            const wallSec = (performance.now() - job.t0) / 1000;
            if (wallSec > 0 && durationSec > 0) {
              this._recordRTF(engineForVoice(job.voice), durationSec / wallSec);
            }
          }
          const tRewav1 = performance.now();
          const tMp30 = performance.now();
          // Transferred (zero-copy) to a free MP3 pool worker.
          const mp3Blob = await wav16ToMp3Blob(data.buffer);
          const tMp31 = performance.now();
          job.stageTimings = {
            gen: T.gen || 0, wav: T.wav || 0,
            join: tJoin1 - tJoin0, rewav: tRewav1 - tJoin1,
            mp3: tMp31 - tMp30, mp3enc: (mp3Blob && mp3Blob._encMs) || 0,
          };
          if (job.cacheKey) {
            try {
              await chunkCacheMeta.set(job.cacheKey, { time: Date.now(), size: mp3Blob.size });
              await chunkCache.set(job.cacheKey, mp3Blob);
            } catch (e) {
              console.warn("chunk cache write failed:", e);
            }
          }
          if (releaseEarly) this._completeDetached(job, mp3Blob, false);
          else this._completeJob(w, job, mp3Blob, false);
        } catch (e) {
          if (releaseEarly) this._failDetached(job, e);
          else this._failJob(w, job, e);
        }
      })();
    } else if (data.type === "error") {
      this._failJob(w, w.currentJob, new Error(data.error));
    }
  }

  // Completion for jobs whose worker was already released (see
  // _onWorkerMessage): same book-token + one-off semantics as _completeJob /
  // _failJob below, but there is no worker state left to clear and no _pump
  // to run — the freed worker already moved on to its next chunk.
  _completeDetached(job, blob, fromCache) {
    if (job && !job.once && job.bookToken !== this._bookToken) return;
    if (job.once) {
      if (job.resolve) job.resolve(blob);
    } else {
      this.onChunk({ index: job.index, textData: job.textData, blob, fromCache });
    }
  }

  _failDetached(job, err) {
    if (job && !job.once && job.bookToken !== this._bookToken) return;
    if (job && job.once) {
      if (job.reject) job.reject(err);
    } else if (job) {
      this.onChunkError({ index: job.index, textData: job.textData, error: err });
    }
  }

  _completeJob(w, job, blob, fromCache) {
    w.busy = false;
    w.currentJob = null;
    // Discard work that belongs to a book the user has left. The check is on the
    // job's book token (claimed worker jobs are removed from `jobs`, so a map
    // lookup can't tell); one-off jobs (voice previews) are never discarded
    // because their promise must always settle.
    if (job && !job.once && job.bookToken !== this._bookToken) { this._pump(); return; }
    if (job.once) {
      if (job.resolve) job.resolve(blob);
    } else {
      this.onChunk({ index: job.index, textData: job.textData, blob, fromCache });
    }
    this._pump();
  }

  _failJob(w, job, err) {
    w.busy = false;
    w.currentJob = null;
    if (job && !job.once && job.bookToken !== this._bookToken) { this._pump(); return; }
    if (job && job.once) {
      if (job.reject) job.reject(err);
    } else if (job) {
      this.onChunkError({ index: job.index, textData: job.textData, error: err });
    }
    this._pump();
  }

  _pump() {
    // Jobs are routed by voice: each worker holds exactly one model (Kokoro or
    // Paradee), so a job can only run on a worker of its own engine.
    while (true) {
      let job = this.onceJobs[0] || null;
      let isOnce = !!job;
      if (!job) {
        const idx = this._nextIndex();
        if (idx == null) return;
        job = this.jobs.get(idx);
        if (!job) continue;
      }
      const engine = engineForVoice(job.voice);
      const w = this.idleWorker(engine);
      if (!w) {
        if (isOnce) {
          // A voice preview has no cache key, so it always needs a worker.
          this.onNeedEngine(engine);
          return;
        }
        // No worker of this engine yet: DON'T blindly spin the pool up just
        // because chunks are queued. A fully-cached (or peer-covered) book can
        // be served entirely without a worker, so let the cache/peer warm pass
        // resolve what it can first; only a confirmed miss (see _warmOne)
        // brings the engine back. This is what stops "click play on an
        // already-narrated book" from initialising 16 wasm workers.
        if (!this.workers.some((x) => x && x.engine === engine && !x.dead)) this._warm();
        return;
      }
      if (isOnce) this.onceJobs.shift();
      else {
        this.jobs.delete(job.index);
        this.pending.delete(job.index);
      }
      w.busy = true;
      w.currentJob = job;
      job.claimed = true;   // a worker owns it now; _warm must leave it alone
      this._dispatch(w, job);
    }
  }

  _nextIndex() {
    if (this.pending.size === 0) return null;
    const focus = this.focus;
    for (let d = 0; d <= this.total; d++) {
      const a = focus + d;
      if (a < this.total && this.pending.has(a)) return a;
      const b = focus - d;
      if (d !== 0 && b >= 0 && this.pending.has(b)) return b;
    }
    const it = this.pending.values().next();
    return it.done ? null : it.value;
  }

  _dispatch(w, job) {
    if (!job.cacheKey) {
      job.t0 = performance.now();
      w.worker.postMessage({ type: "process", textData: job.textData, voice: job.voice, index: job.index });
      return;
    }
    (async () => {
      let cached = null;
      try {
        cached = await chunkCache.get(job.cacheKey);
      } catch (e) {
        console.warn("chunk cache read failed:", e);
      }
      // Not cached here — try a synced peer before handing this to a worker.
      if (!cached && peerChunkFetcher) {
        try {
          const fromPeer = await peerChunkFetcher(job.cacheKey);
          if (fromPeer) { await putCachedChunk(job.cacheKey, fromPeer); cached = fromPeer; }
        } catch (e) { /* peer fetch is best-effort */ }
      }
      // The book may have been switched while we were probing; drop the job
      // rather than synthesise audio for a book the user has left.
      if (job.bookToken !== this._bookToken) { w.busy = false; w.currentJob = null; this._pump(); return; }
      if (cached) {
        await new Promise((r) => setTimeout(r, 0));
        this._completeJob(w, job, cached, true);
      } else {
        job.t0 = performance.now();
        w.worker.postMessage({ type: "process", textData: job.textData, voice: job.voice, index: job.index });
      }
    })();
  }

  setBook(chunks, voice) {
    this.jobs.clear();
    this.pending.clear();
    this.voice = voice;
    this.total = chunks.length;
    this.focus = 0;
    this._bookToken++;
    const token = this._bookToken;
    // Prefetch restarts for the new book; the cursors are anchored on the first
    // setFocus that follows (which knows the real starting position).
    this._pfFocus = null;
    this._pfAhead = 0;
    this._pfBehind = -1;
    chunks.forEach((textData, index) => {
      this.jobs.set(index, { index, textData, voice, cacheKey: cacheKeyFor(voice, textData), bookToken: token });
      this.pending.add(index);
    });
    this._pump();
    this._warm();
  }

  setFocus(index) {
    this.focus = Math.max(0, Math.min(this.total - 1, index | 0));
    this._pump();
    this._warm();
    this._prefetch();
  }

  // --- cache/peer warm-up (independent of the synthesis workers) -------------
  // The worker pool only touches a chunk once a voice model is loaded, but the
  // local cache needs no model at all (and a linked peer can hand us finished
  // audio right away). Resolving those on the side is what lets a device start
  // streaming a book it already narrated — here or elsewhere — WITHOUT spinning
  // up any workers, and lets a low-powered device play from a peer while its own
  // model warms. Anything we can't find is left in `pending`; if that miss is
  // close enough to the playhead to matter, we ask for the engine (see below).
  async _warmOne(job) {
    let blob = null;
    try { blob = await chunkCache.get(job.cacheKey); } catch (e) {}
    if (!blob && peerChunkFetcher) {
      try { blob = await peerChunkFetcher(job.cacheKey); } catch (e) {}
      if (blob) { try { await putCachedChunk(job.cacheKey, blob); } catch (e) {} }
    }
    job.resolving = false;
    // Drop the result if this job is no longer current (book switched, a worker
    // claimed it, a peer already satisfied it). This keeps a stale in-flight
    // warm from pulling the engine back up after the user moved on.
    if (job.claimed || !this.pending.has(job.index) || this.jobs.get(job.index) !== job) return;
    if (!blob) {
      // A confirmed miss within the warm window: this chunk genuinely has to be
      // synthesised, so the pool is required. (If workers already exist, _pump
      // has it covered.) Note this fires only for chunks near the playhead, so a
      // fully-cached book never triggers it and never initialises workers.
      const engine = engineForVoice(job.voice);
      if (!this.workers.some((w) => w && w.engine === engine && w.ready && !w.dead)) this.onNeedEngine(engine);
      return;
    }
    this.pending.delete(job.index);
    this.jobs.delete(job.index);
    if (job.once) { if (job.resolve) job.resolve(blob); }
    else this.onChunk({ index: job.index, textData: job.textData, blob, fromCache: true });
    this._pump();
  }

  _warm() {
    if (this._warmInFlight >= WARM_MAX || !this.pending.size) return;
    const focus = this.focus;
    const idxs = [...this.pending]
      .filter((i) => i >= focus - WARM_BEHIND && i <= focus + WARM_AHEAD)
      .sort((a, b) => Math.abs(a - focus) - Math.abs(b - focus));
    for (const idx of idxs) {
      if (this._warmInFlight >= WARM_MAX) break;
      const job = this.jobs.get(idx);
      if (!job || job.claimed || job.resolving || job.warmTried) continue;
      // Marked before the attempt so a miss isn't retried in a loop; a chunk we
      // couldn't warm still gets a worker later (once init completes) or a peer
      // try from _dispatch before it is synthesised.
      job.warmTried = true;
      job.resolving = true;
      this._warmInFlight++;
      this._warmOne(job).catch(() => {}).finally(() => { this._warmInFlight--; this._warm(); });
    }
  }

  // --- whole-book prefetch (background) --------------------------------------
  // `_warm` only *delivers* chunks near the playhead, so a device playing a book
  // that was generated elsewhere would otherwise only ever pull the next few
  // chunks from a peer — close that tab and playback dies at the edge of the
  // window. The prefetch pass fixes that: it walks the whole book and resolves
  // every remaining chunk into the LOCAL chunk cache (from the cache itself, or
  // a linked peer), WITHOUT involving the player or the worker pool and without
  // ever asking for the engine. A miss is remembered and left for `_warm` (if it
  // is near the playhead) or a later retry, so it can neither stall playback nor
  // drag the pool up. Range is prefetchAhead/prefetchBehind around the playhead;
  // both default to Infinity (the whole book).
  async _prefetchOne(job) {
    // Probe the tiny metadata record, not the audio blob: for a book that is
    // already fully cached this avoids re-reading every chunk's bytes just to
    // confirm it's there. (The real blob is read when the chunk is delivered.)
    let has = false;
    try { has = !!(await chunkCacheMeta.get(job.cacheKey)); } catch (e) {}
    if (!has && peerChunkFetcher && (!peerChunkAvailable || peerChunkAvailable())) {
      let blob = null;
      try { blob = await peerChunkFetcher(job.cacheKey); } catch (e) {}
      if (blob) { try { await putCachedChunk(job.cacheKey, blob); has = true; } catch (e) {} }
    }
    job.prefetching = false;
    // Drop the result if the job is no longer current (book switched, a worker
    // claimed it, `_warm` already delivered it).
    if (job.claimed || !this.pending.has(job.index) || this.jobs.get(job.index) !== job) return;
    if (has) job.cached = true;
  }

  // Walk the prefetch cursors outward from the anchor and return the next job
  // that still needs resolving, or null when the range is exhausted.
  _pfDraw() {
    const total = this.total;
    const f = this._pfFocus;
    const aheadLim = isFinite(this.prefetchAhead) ? Math.min(total - 1, f + this.prefetchAhead) : total - 1;
    const behindLim = isFinite(this.prefetchBehind) ? Math.max(0, f - this.prefetchBehind) : 0;
    while (this._pfAhead <= aheadLim) {
      const job = this._pfReady(this._pfAhead++);
      if (job) return job;
    }
    while (this._pfBehind >= behindLim) {
      const job = this._pfReady(this._pfBehind--);
      if (job) return job;
    }
    return null;
  }

  _pfReady(i) {
    if (i < 0 || i >= this.total) return null;
    const job = this.jobs.get(i);
    if (!job || job.claimed || job.prefetching || job.prefetchTried || job.cached) return null;
    if (!this.pending.has(i)) return null;
    return job;
  }

  _prefetch() {
    if (this._prefetchInFlight >= PREFETCH_MAX || !this.pending.size) return;
    if (this._pfFocus == null) {
      this._pfFocus = this.focus;
      this._pfAhead = this.focus;
      this._pfBehind = this.focus - 1;
    }
    while (this._prefetchInFlight < PREFETCH_MAX) {
      const job = this._pfDraw();
      if (!job) return;   // range (or the whole book) is exhausted
      job.prefetchTried = true;
      job.prefetching = true;
      this._prefetchInFlight++;
      this._prefetchOne(job).catch(() => {}).finally(() => { this._prefetchInFlight--; this._prefetch(); });
    }
  }

  // Re-arm the prefetch (e.g. a device-sync peer just appeared) so chunks that
  // missed earlier are asked for again. The cursors have usually run to the end
  // of the book by then, so they must be rewound too or the draw would find
  // nothing left to visit.
  kickPrefetch() {
    for (const i of this.pending) { const j = this.jobs.get(i); if (j) j.prefetchTried = false; }
    if (this._pfFocus != null) {
      this._pfAhead = this._pfFocus;
      this._pfBehind = this._pfFocus - 1;
    }
    this._prefetch();
  }

  // Adjust the prefetch range at runtime. Infinity = the whole book.
  setPrefetchWindow({ ahead, behind } = {}) {
    if (ahead != null) this.prefetchAhead = ahead;
    if (behind != null) this.prefetchBehind = behind;
    this.kickPrefetch();
  }

  previewVoice(text, voice) {
    return new Promise((resolve, reject) => {
      this.onceJobs.push({ once: true, index: null, textData: { text }, voice, resolve, reject, cacheKey: null });
      this._pump();
    });
  }

  _startCacheCleanup() {
    if (this._cacheTimer) return;
    const run = async () => {
      try {
        const metaEntries = await chunkCacheMeta.entries();
        let byteSum = metaEntries.reduce((s, [, d]) => s + ((d && d.size) || 0), 0);
        for (const [key, data] of metaEntries) {
          if (!key.startsWith("v2:")) {
            await chunkCache.delete(key);
            await chunkCacheMeta.delete(key);
            continue;
          }
          // A single long audiobook can be a couple of GB, so allow 5GB total.
          if (Date.now() - data.time > 1000 * 60 * 60 * 24 * 7 || byteSum > 5 * 1024 * 1024 * 1024) {
            await chunkCache.delete(key);
            await chunkCacheMeta.delete(key);
            byteSum -= data.size;
          }
        }
      } catch (e) {
        console.warn("chunk cache cleanup:", e);
      }
    };
    run();
    this._cacheTimer = setInterval(run, 1000 * 60 * 5);
  }

  // Release the worker pools (each Kokoro wasm worker holds a full copy of the
  // model (~0.25-0.3 GB), so an idle pool is the single biggest thing this app
  // keeps in memory) while keeping the engine instance, its queued jobs and
  // its cache timer intact. The next `setBook`/`setFocus`/`previewVoice` asks
  // for a rebuild via `onNeedEngine`, and `init()` recreates the pools in place.
  unload() {
    if (!this.workers.some(Boolean) && !Object.values(this.pools).some((p) => p.promise)) return false;
    for (const w of this.workers) {
      try { w && w.worker.terminate(); } catch (e) {}
    }
    this.workers = [];
    for (const p of Object.values(this.pools)) {
      p.ready = false;
      p.promise = null;
      p.nextIdx = 0;
    }
    this.rtfSamples = { kokoro: [], paradee: [], titl: [], paradee11: [] };
    this.ready = false;
    return true;
  }

  dispose() {
    for (const w of this.workers) {
      try { w && w.worker.terminate(); } catch (e) {}
    }
    this.workers = [];
    if (this._cacheTimer) clearInterval(this._cacheTimer);
    try { URL.revokeObjectURL(this._workerUrl); } catch (e) {}
  }
}
