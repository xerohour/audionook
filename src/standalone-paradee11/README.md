# paradee11 — portable Paradee v1.1 speech in one file + one download

Local text-to-speech for any web app or game: one expressive 8M-parameter
voice ("Heart", an `af_heart` student) that runs **~50x realtime on a single
CPU thread** — no WebGPU, no server, no API key, text never leaves the device.
The whole runtime ships as **one ~20 MB binary, downloaded once**, then shared
by every worker from memory. Workers make **zero** runtime fetches, and the
pool **never uses more than half of `navigator.hardwareConcurrency`**.

## Files (all permanent URLs)

| file | URL | bytes | what |
|---|---|---|---|
| `paradee11.js` (the loader — import this) | https://user.uploads.dev/file/eb680b5122438878e42c0d8cc70d9ef2.js | ~30 KB | pool, chunking, WAV/MP3, ergonomic API |
| `paradee11-rt.bundle` (the single binary) | https://user.uploads.dev/file/4047fc593b6dbd67b109ac649e014ac6.bin | 19,697,087 | ORT runtime + int8 model + tokenizer |
| `build-paradee11-bundle.js` (rebuild script) | https://user.uploads.dev/file/6130582b6eec90d8ecb320f8f491a5cf.js | ~4 KB | re-assembles the bundle from pinned sources |

Bundle contents (SHA-256):

| section | bytes | sha256 |
|---|---|---|
| `ort-mjs` (ONNX Runtime glue, wasm-only CPU build) | 20,856 | `30dd851d…705385a8` |
| `ort-wasm` (compiled kernels, single file, no side modules) | 11,210,254 | `71aef049…4533fe4` |
| `model-int8` (Paradee-8M-v1.1 int8, HF rev `v1.1`) | 8,461,438 | `665c3cce…43defbc` |
| `tokenizer` (shared phoneme vocabulary) | 3,497 | `77a02c8e…060a34` |

## Quickstart

```html
<script type="module">
  import { createParadee } from "https://user.uploads.dev/file/eb680b5122438878e42c0d8cc70d9ef2.js";

  // Downloads the bundle once (~20 MB), warms up, spawns workers.
  // Do this at boot behind a loading screen — first audio lands in ~2 s,
  // sustained output runs ~50x realtime (one short line renders in ~100 ms).
  const tts = await createParadee();

  // The common case: text -> playable MP3 blob.
  const mp3 = await tts.say("Hello, world!");
  new Audio(URL.createObjectURL(mp3)).play();
</script>
```

Game dialogue (many short lines, cancelable):

```js
// Keep one instance for the whole session.
const line = await tts.say(npcLine);          // Blob(audio/mp3)
sfx.play(URL.createObjectURL(line));

// Cancel a queued line (e.g. player skipped the cutscene):
const ctl = new AbortController();
tts.say(currentQuestText, { signal: ctl.signal }).then(play).catch(() => {});
ctl.abort();
```

Long-form narration (audiobooks, journals, lore entries) — same `say`,
no guessing at length limits. Any text of any length is sentence-chunked
across the pool and returned as **one combined MP3**:

```js
const mp3 = await tts.say(chapterText, {
  onChunk: (mp3Blob, index, total) => audioQueue.push({ mp3Blob, index }),
});
```

`sayLong` is a legacy alias (same chunking, but also returns the per-chunk
blobs: `{ blob, blobs, count }`). Prefer `say`.

Raw audio + WAV (custom pipelines, visualizers, Web Audio graphs):

```js
const { audio, sampleRate } = await tts.sayRaw("Hello"); // Float32Array @ 24000 Hz
const wav = await tts.sayWav("Hello");                   // Blob(audio/wav)
```

Custom bundle location / worker count / progress UI:

```js
const tts = await createParadee({
  bundleUrl: "https://my-cdn.example/paradee11-rt.bundle", // same format
  maxWorkers: 2,                // default "auto": min(8, floor(cores/2) - 1)
  fallbackModelUrl: null,       // optional remote int8 URL if the bundle lacks the model
  onProgress: ({ phase, progress }) => splash.textContent = phase + " " + Math.round(progress * 100) + "%",
});
tts.close(); // terminate workers when done (frees ~100+ MB)
```

## API reference

- `createParadee({ bundleUrl?, urls?, maxWorkers?, fallbackModelUrl?, onProgress? })` → `tts`
  - `maxWorkers`: `"auto"` (default) or a number (clamped to 16). Auto = `max(1, min(8, floor(cores/2) − 1))` — one budget thread is reserved for the MP3 encoder, so TTS + MP3 combined stay within half of `hardwareConcurrency`. A 4-core phone runs 1 TTS + 1 MP3 worker.
  - `urls`: override any pinned dependency (`ort`, `kokoro`, `transformers`, `lame`, `bundle`).
- `tts.say(text, { signal?, onChunk? })` → `Blob(audio/mp3)` — CBR 128 kbps mono 24 kHz, **any length** (short text: single inference; long text: chunked across the pool, concatenated in order, encoded once; `onChunk(mp3, i, total)` streams per-chunk MP3s in completion order).
- `tts.sayLong(text, { signal?, onChunk? })` → `{ blob, blobs, count }` — legacy alias: same as `say` but also returns the per-chunk `blobs` in chunk order plus the combined `blob`.
- `tts.sayWav(text, { signal? })` → `Blob(audio/wav)` (16-bit PCM, any length).
- `tts.sayRaw(text, { signal? })` → `{ audio: Float32Array, sampleRate: 24000 }` (any length, concatenated in order).
- `tts.workers`, `tts.bundleBytes`, `tts.sampleRate`, `tts.voiceName`, `tts.close()`.
- Helpers (also exported): `splitTextIntoChunks(text, maxSize?)`, `toMisaki(phonemes)`, `floatToWavBlob()`, `floatToMp3Blob()`, `loadBundle(url)`, `cpuBudget(cores)`, `defaultWorkerCount(cores)`.
- Single voice. The student only ever learned one speaker (`af_heart`), so there is no voice picker — pitch/rate effects are up to your audio graph.

Browser notes: create the instance after a user gesture if you will `AudioContext`-play immediately (autoplay policy); the workers themselves need no gesture. Everything runs on CPU — no WebGPU, no SIMD flags to check (plain wasm, works everywhere).

## Architecture (why it is fast to load)

The classic failure it replaces: every worker downloading the model (~8.5 MB)
*and* a 22 MB runtime side module at first inference — 16 workers ≈ 528 MB.
This package instead:

1. Serves ONNX Runtime's **wasm-only entry** (`ort.wasm.min.mjs`), not the
   default all-backend bundle. The default entry hardcodes a JSEP build that
   every worker downloads at first inference even for pure-CPU sessions; the
   wasm-only entry loads one 11.2 MB file with no side modules.
2. Packs runtime + model + tokenizer into **one indexed binary** (magic
   `P11BNDL1`, JSON header with offsets + SHA-256). One `fetch`, sliced into
   memory-served `blob:` URLs handed to every worker via init params.
3. Pre-warms the three static JS imports on the main thread, so the worker
   burst resolves from HTTP cache. Result: workers make zero runtime fetches
   (verified with all remote fallbacks poisoned: 16/16 workers from memory,
   exactly one bundle request).
4. The phonemizer (eSpeak data) is embedded in the G2P bundle — nothing loads
   lazily at first inference, so all workers spawn immediately (~1.3 s pool
   fill) with no warmup tax.

Text pipeline per chunk: normalize + expand (kokoro-js) → eSpeak phonemes →
`toMisaki()` respelling (the student only learned misaki spellings; raw eSpeak
mumbles at 31% WER) → token ids → int8 ONNX (single thread) → 24 kHz float
audio → (paragraph pause) → MP3. Chunking is abbreviation/acronym-aware
("Mr.", "U.S.", "Ph.D.", domains, decimals never split mid-token).

Why chunking is mandatory, not a Kokoro quirk: the text side has 512
positions, two taken by pads, so Paradee itself caps input at 510 phonemes
(`MAX_PHONEMES` in `paradee/tts.py` — "long text is read one sentence at a
time", over-long sentences cut at the last fitting space). The tokenizer is
created with `model_max_length: 512`, so feeding more silently truncates
past 512 — lost endings and degraded prosody. Chickadee does the same: one
synthesis per sentence with N+1/N+2 prefetch (`engine.js`), `splitSentences()`
with a 380-char hard split (`panel.js`, `content.js`). There is no length for
callers to guess at: `say`/`sayRaw` split automatically.

## Build your own bundle

The published binary is reproducible. Download the
[build script](https://user.uploads.dev/file/6130582b6eec90d8ecb320f8f491a5cf.js),
fetch its four pinned inputs, run it (it uses an `fs` global; paste it into an
`execute_js` call in a Perchance generator, or provide `{ readFile, writeFile }`):

| input | pinned source |
|---|---|
| `ort-mjs` | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.mjs` |
| `ort-wasm` | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm` |
| `model-int8` | `https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.1/resolve/v1.1/onnx/paradee_int8.onnx` |
| `tokenizer` | the repo's `tokenizer.json` (same rev; shared vocab) |

Then serve the output with `Content-Type: application/octet-stream` and pass
its URL as `bundleUrl`. The loader sanity-checks magic + glue on load and
falls back to remote URLs for anything missing, so a damaged bundle degrades
instead of breaking.

Pinned JS dependencies (override via `urls`): ORT
`onnxruntime-web@1.22.0` (wasm-only dist file), `kokoro-js@1.2.1`,
`@huggingface/transformers@3.5.1` (tokenizer only), `lamejs@1.2.1` (MP3).

## Licenses / attribution (check these for your title)

- Paradee weights + misaki table: Sahil Mahendrakar, Apache-2.0 (same as Kokoro).
- ONNX Runtime Web: MIT. kokoro-js + transformers: Apache-2.0.
- MP3: `lamejs` (LGPL) — fine for web use, but read the LGPL if you ship a
  native/app-store wrapper.
- Speech: the eSpeak-NG phonemizer data (pulled in via kokoro-js's G2P stack)
  carries its own license — verify it fits proprietary titles before shipping
  one. The model, runtime, and your text stay fully local regardless.
