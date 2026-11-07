/**
 * Minimal benchmark helper for the QA performance suite (`test/perf/**`).
 *
 * The performance tests exist to **record numbers**, not to gate CI on timing:
 * every case prints one machine-readable `PERF {...}` JSON line with the measured
 * duration, and only the functional assertions around it can fail. Numbers are
 * collected by `node .agents/accept-v2/run.mjs`-style evidence reports and the
 * QA baseline in `.agents/plan/QA.md`.
 *
 * Warm-up iterations are excluded from the timing so the first-call JIT cost of
 * a large bundle import does not dominate a 10-iteration micro-benchmark.
 *
 * @module test/perf/perf
 */

import { performance } from 'node:perf_hooks'

/** One recorded benchmark sample, serialized to a `PERF` log line. */
export interface PerfSample {
  /** Suite name, e.g. `store` / `markdown` / `retrieval` / `unzip`. */
  suite: string
  /** Case name within the suite. */
  case: string
  /** Input size in bytes when the case has a meaningful payload size. */
  bytes: number | null
  /** Measured iterations (warm-up excluded). */
  iters: number
  /** Total measured wall time in milliseconds. */
  totalMs: number
  /** Mean milliseconds per operation. */
  msPerOp: number
  /** Operations per second implied by `msPerOp`. */
  opsPerSec: number
  /** Optional free-form annotation (e.g. fixture source, document count). */
  note: string | null
}

/** Options accepted by {@link measureSync} / {@link measureAsync}. */
export interface MeasureOptions {
  suite: string
  case: string
  /** Measured iterations; defaults to 10. */
  iters?: number
  /** Warm-up iterations; defaults to `min(3, iters)`. */
  warmup?: number
  /** Input size in bytes, when meaningful. */
  bytes?: number
  /** Free-form annotation stored on the sample. */
  note?: string
}

/** Print one machine-readable sample line (the stable format QA parses). */
export function printPerf(sample: PerfSample): void {
  console.log(`PERF ${JSON.stringify(sample)}`)
}

/** Build one sample from raw timing data. */
function toSample(options: MeasureOptions, iters: number, totalMs: number): PerfSample {
  const msPerOp = totalMs / iters
  return {
    suite: options.suite,
    case: options.case,
    bytes: options.bytes ?? null,
    iters,
    totalMs: Math.round(totalMs * 1000) / 1000,
    msPerOp: Math.round(msPerOp * 1e6) / 1e6,
    opsPerSec: msPerOp > 0 ? Math.round(1000 / msPerOp) : 0,
    note: options.note ?? null,
  }
}

/**
 * Time a synchronous operation and print one PERF line.
 *
 * @param options - suite/case names and iteration counts.
 * @param fn - operation under test; may return a value (ignored).
 * @returns the recorded sample.
 */
export function measureSync(options: MeasureOptions, fn: () => unknown): PerfSample {
  const iters = options.iters ?? 10
  const warmup = options.warmup ?? Math.min(3, iters)
  for (let index = 0; index < warmup; index += 1) fn()
  const startedAt = performance.now()
  for (let index = 0; index < iters; index += 1) fn()
  const sample = toSample(options, iters, performance.now() - startedAt)
  printPerf(sample)
  return sample
}

/**
 * Time an asynchronous operation and print one PERF line.
 *
 * @param options - suite/case names and iteration counts.
 * @param fn - async operation under test.
 * @returns the recorded sample.
 */
export async function measureAsync(options: MeasureOptions, fn: () => Promise<unknown>): Promise<PerfSample> {
  const iters = options.iters ?? 10
  const warmup = options.warmup ?? Math.min(2, iters)
  for (let index = 0; index < warmup; index += 1) await fn()
  const startedAt = performance.now()
  for (let index = 0; index < iters; index += 1) await fn()
  const sample = toSample(options, iters, performance.now() - startedAt)
  printPerf(sample)
  return sample
}
