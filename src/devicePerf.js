// ===========================================================================
// devicePerf.js — cheap, JIT-robust performance tier for the default voice.
//
// Goal: pick the right DEFAULT narrator on first boot. Kokoro's big Heart
// voice (af_heart, ~325 MB) needs roughly 2x realtime to listen comfortably;
// the Light voice (paradee11_heart, 8.5 MB) runs ~50-100x realtime even on a
// phone. A slow device that defaults to Kokoro stalls on "buffering"; a fast
// device that defaults to Light gets a worse voice for no reason. So fresh
// installs (no saved voice yet) probe the device once and default to Light
// only when the device is LIKELY too slow for Kokoro.
//
// Why this is reliable (and not JIT-noise):
// - Static signals first (zero noise): core count, device memory, mobile UA,
//   threaded-wasm availability (SharedArrayBuffer + crossOriginIsolated),
//   WebGPU presence. Clear-cut devices never run the benchmark at all.
// - The benchmark itself is JIT-hardened: 2 untimed warmup runs (lets the
//   JIT optimise + warms the cache), then 5 timed runs with a yield between
//   each, taking the MEDIAN (robust to one slow outlier from GC/scheduling).
//   Work is allocation-free in the hot loop (preallocated Float32Arrays) and
//   deterministic (seeded data), so runs are comparable. If variance is high
//   (max-min > 50% of median) the result is discarded as noisy and we fall
//   back to the static signals instead of trusting a flaky number.
// - Bounded: the whole probe caps at ~600 ms and fails OPEN (returns "fast" /
//   Kokoro) on any error or timeout, so a weird browser never gets a worse
//   default voice because the probe itself glitched.
// - Conservative thresholds: only clearly-slow devices get Light. Borderline
//   devices keep the higher-quality Kokoro default; the runtime backstop in
//   app.js (onSpeed < 1.5x over 5 real chunks) still suggests Light later if
//   real synthesis is actually slow. A false-Kokoro is recoverable via toast;
//   a false-Light would silently downgrade a fast device with no signal.
//
// Calibration: N=160 float matmul measures ~4.4 ms median on a 64-core Linux
// desktop (Chrome). A mid-range phone measures ~15-30 ms single-threaded with
// far fewer cores. `score = medianMs / cores` separates them by ~50x
// (desktop ~0.07, 4-core phone ~5). The SLOW_SCORE threshold (1.8) and the
// SLOW_SINGLE_MS cap (28 ms, very slow per-core even with many cores) only
// fire well into phone territory.
// ===========================================================================

const MAT_N = 160;
const WARMUP_RUNS = 2;
const TIMED_RUNS = 5;
const SLOW_SINGLE_MS = 28;   // single-core this slow => Light, whatever the cores
const SLOW_SCORE = 1.8;      // medianMs/cores above this => Light
const PROBE_BUDGET_MS = 600; // total benchmark cap; exceed => noisy fallback

export function staticSignals() {
  const nav = (typeof navigator !== "undefined" && navigator) || {};
  const cores = Math.max(1, Number(nav.hardwareConcurrency) || 4);
  const mem = Number(nav.deviceMemory) || 0; // GB, Chrome-only; 0 = unknown
  const hasWebGpu = typeof nav.gpu !== "undefined" && !!nav.gpu;
  // Threaded wasm (what fast Kokoro needs) requires SharedArrayBuffer AND a
  // cross-origin-isolated context. Without it every session is single-threaded.
  const hasSAB = typeof SharedArrayBuffer !== "undefined";
  let coi = false;
  try { coi = !!window.crossOriginIsolated; } catch (e) { coi = false; }
  const threadedWasm = hasSAB && coi;
  const ua = String((nav.userAgent) || "");
  const isMobileUA = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
  let coarsePointer = false;
  try { coarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); } catch (e) {}
  const isMobile = isMobileUA || (coarsePointer && Math.min(screen.width || 0, screen.height || 0) > 0 && Math.min(screen.width, screen.height) < 600);
  return { cores, mem, hasWebGpu, hasSAB, coi, threadedWasm, isMobile, ua };
}

// Fast path without any benchmark. Returns true (Light) / false (Kokoro) /
// null (run the benchmark to decide).
export function staticTier(s = staticSignals()) {
  // Very few cores: a 4-core phone runs 1 TTS worker; Kokoro can't hit 2x.
  if (s.cores <= 4 && !s.hasWebGpu) return true;
  if (s.cores <= 4 && s.isMobile) return true;
  // Very little RAM: model + workers + page won't comfortably fit Kokoro.
  if (s.mem && s.mem <= 3) return true;
  // No threaded wasm on a small machine: single-threaded sessions only.
  if (!s.threadedWasm && s.cores <= 6) return true;
  // Phones with few cores are slow even with decent per-core speed.
  if (s.isMobile && s.cores <= 6) return true;
  // Big machines are fine without measuring: 16+ threaded cores always clear
  // 2x on Kokoro (wasm pool does ~7-8x audio/sec on the reference box).
  if (s.cores >= 16 && s.threadedWasm) return false;
  // A GPU path + enough CPU almost always clears 2x even if the CPU is mid.
  if (s.hasWebGpu && s.cores >= 8 && s.threadedWasm && !s.isMobile) return false;
  return null;
}

let _benchCache = null;

function buildMatrices(n) {
  const A = new Float32Array(n * n), B = new Float32Array(n * n), C = new Float32Array(n * n);
  let s = 1234567;
  for (let i = 0; i < n * n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    A[i] = (s / 0x7fffffff) * 2 - 1;
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    B[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return { A, B, C };
}

// Naive ijk matmul over preallocated typed arrays. Deliberately simple and
// monomorphic (same shapes every call) so the JIT settles after warmup; the
// checksum read keeps the loops from being dead-code-eliminated.
function matmulOnce(A, B, C, n) {
  C.fill(0);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = A[i * n + k];
      const base = i * n, bk = k * n;
      for (let j = 0; j < n; j++) C[base + j] += a * B[bk + j];
    }
  }
  let sum = 0;
  for (let i = 0; i < n * n; i += 32) sum += C[i];
  return sum;
}

function medianSorted(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export async function quickBenchmark() {
  if (_benchCache) return _benchCache;
  const started = (performance.now ? performance.now() : Date.now());
  const { A, B, C } = buildMatrices(MAT_N);
  for (let i = 0; i < WARMUP_RUNS; i++) matmulOnce(A, B, C, MAT_N);
  const times = [];
  for (let i = 0; i < TIMED_RUNS; i++) {
    if ((performance.now ? performance.now() : Date.now()) - started > PROBE_BUDGET_MS) break;
    const t0 = performance.now ? performance.now() : Date.now();
    matmulOnce(A, B, C, MAT_N);
    const t1 = performance.now ? performance.now() : Date.now();
    times.push(t1 - t0);
    // Yield so GC/scheduling noise doesn't bunch into one long pause, and so
    // the boot splash can paint between runs.
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!times.length) return null;
  const med = medianSorted(times);
  const lo = Math.min.apply(null, times), hi = Math.max.apply(null, times);
  const noisy = med <= 0 || (hi - lo) > med * 0.5 + 2.5;
  const out = { medianMs: med, minMs: lo, maxMs: hi, runs: times.length, noisy };
  _benchCache = out;
  return out;
}

// Main entry: true => default to the Light voice. Never throws; fails open
// (false = Kokoro) on any error, timeout, or noisy measurement.
export async function shouldDefaultToLight() {
  try {
    const s = staticSignals();
    const tier = staticTier(s);
    if (tier !== null) return tier;
    const b = await Promise.race([
      quickBenchmark(),
      new Promise((res) => setTimeout(() => res(null), PROBE_BUDGET_MS + 150)),
    ]);
    if (!b || b.noisy) {
      // Noisy benchmark: trust only the static shape. Small/mobile => Light.
      if (s.cores <= 6 || s.isMobile) return true;
      if (!s.threadedWasm && s.cores <= 8) return true;
      return false;
    }
    if (b.medianMs >= SLOW_SINGLE_MS) return true;
    const score = b.medianMs / Math.max(1, s.cores);
    if (score >= SLOW_SCORE) return true;
    // Slow single core on a mid machine: first-chunk latency still hurts even
    // if many cores could brute-force throughput, so lean Light.
    if (b.medianMs >= 14 && s.cores <= 8 && !s.hasWebGpu) return true;
    return false;
  } catch (e) {
    return false;
  }
}
