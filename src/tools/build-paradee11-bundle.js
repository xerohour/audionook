// ===========================================================================
// build-paradee11-bundle.js — assemble the single-file Paradee v1.1 runtime
// bundle ("ULTIMATE portable" Light voice payload).
//
// WHAT IT PACKS (all bytes pinned, hashes recorded in the bundle header):
//   ort-mjs        onnxruntime-web 1.22.0 wasm-only (JSEP-less CPU) glue,
//                  dist/ort-wasm-simd-threaded.mjs           (~21 KB)
//   ort-wasm       its compiled kernels, no side module needed (11.2 MB)
//   model-int8     Paradee-8M-v1.1 int8 ONNX (8.46 MB)
//   tokenizer      paradee tokenizer.json (shared vocab, ~3.5 KB)
//
// WHY JSEP-less: the default onnxruntime-web entry loads
// ort-wasm-simd-threaded.jsep.mjs + a 22 MB jsep.wasm side module per worker
// (16 workers = ~528 MB). The wasm-only entry (ort.wasm.min.mjs) loads the
// plain threaded build instead: one 11.2 MB file, zero side modules — the
// "stripped down ONNX build specifically for paradee v1.1".
//
// FORMAT: magic[8]="P11BNDL1" | u32LE headerLen | headerJSON | payloads...
// header = {bundle, version, created, sources, files:[{name,offset,length,sha256}]}
// offsets are absolute from byte 0 of the bundle file.
//
// RUN: paste this file's contents into an execute_js call (it uses the
// execute_js `fs` global), e.g.:
//   const src = await fs.readTextFile("src/tools/build-paradee11-bundle.js");
//   await Object.getPrototypeOf(async function(){}).constructor("fs", src)(fs);
// REBUILD from scratch: re-download the four inputs to scratch/rt/ (see
// SOURCES below), then run this script; output src/paradee11-rt.bundle.
// ===========================================================================

const SOURCES = {
  "ort-mjs": {
    input: "scratch/rt/ort-wasm-simd-threaded.mjs",
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.mjs",
  },
  "ort-wasm": {
    input: "scratch/rt/ort-wasm-simd-threaded.wasm",
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm",
  },
  "model-int8": {
    input: "scratch/paradee11-int8.onnx",
    url: "https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.1/resolve/v1.1/onnx/paradee_int8.onnx",
  },
  "tokenizer": {
    input: "src/paradee-tokenizer.json",
    url: "vendored src/paradee-tokenizer.json (HF Paradee-8M-v1.0 tokenizer.json, shared vocab)",
  },
};

const OUTPUT = "src/paradee11-rt.bundle";
const MAGIC = "P11BNDL1"; // 8 ASCII bytes

async function sha256Hex(u8) {
  const d = await crypto.subtle.digest("SHA-256", u8);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const order = ["ort-mjs", "ort-wasm", "model-int8", "tokenizer"];
const parts = [];
for (const name of order) {
  const data = new Uint8Array(await fs.readFile(SOURCES[name].input));
  parts.push({ name, data, sha256: await sha256Hex(data), url: SOURCES[name].url });
}

// Header first (offsets computed with the final header length).
const headerBase = {
  bundle: "paradee11-rt",
  version: 1,
  created: new Date().toISOString(),
  ortVersion: "1.22.0",
  modelRev: "v1.1",
  files: [],
};
let headerJson = JSON.stringify({ ...headerBase, files: parts.map((p) => ({ name: p.name })) });
let headerBytes = new TextEncoder().encode(headerJson);
let files;
for (;;) {
  const base = 8 + 4 + headerBytes.length;
  let off = base;
  files = parts.map((p) => {
    const f = { name: p.name, offset: off, length: p.data.length, sha256: p.sha256, source: p.url };
    off += p.data.length;
    return f;
  });
  const next = new TextEncoder().encode(JSON.stringify({ ...headerBase, files }));
  if (next.length === headerBytes.length) { headerBytes = next; break; }
  headerBytes = next; // one more pass (lengths are stable; converges in <=2)
}

const total = 8 + 4 + headerBytes.length + parts.reduce((s, p) => s + p.data.length, 0);
const out = new Uint8Array(total);
new TextEncoder().encodeInto(MAGIC, out);
new DataView(out.buffer).setUint32(8, headerBytes.length, true);
out.set(headerBytes, 12);
for (const f of files) {
  const p = parts.find((x) => x.name === f.name);
  out.set(p.data, f.offset);
}
await fs.writeFile(OUTPUT, out);

return {
  output: OUTPUT,
  bytes: total,
  files: files.map((f) => ({ name: f.name, offset: f.offset, length: f.length, sha256: f.sha256.slice(0, 16) + "…" })),
};
