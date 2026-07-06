// Shared micro-benchmark helper for the showcase demos. Server-only (`.server`
// suffix keeps it out of the client graph). Deliberately tiny and honest: it
// reports the median (p50), the p95 tail, the mean, and the sample count `n`
// over timed runs, after a few untimed warm-up runs to let the JIT and any
// lazy native init settle.
//
// CONTRACT (relied on by benchmarks.server.ts and every demo):
//   timeIt(label, fn, iterations?) -> Promise<BenchResult>
//   - `fn` is called `iterations` times (default 30); it may be sync or async.
//   - the first min(3, iterations) calls are warm-up and are NOT timed.
//   - returned times are milliseconds, rounded to 3 decimals.

export interface BenchResult {
  label: string;
  p50: number;
  p95: number;
  mean: number;
  n: number;
}

const DEFAULT_ITERATIONS = 30;
const WARMUP_RUNS = 3;

const round = (ms: number): number => Number(ms.toFixed(3));

// Nearest-rank percentile over an already-sorted ascending array.
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

export async function timeIt(
  label: string,
  fn: () => unknown | Promise<unknown>,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<BenchResult> {
  if (iterations < 1) {
    throw new Error(`timeIt("${label}"): iterations must be >= 1`);
  }

  for (let i = 0; i < Math.min(WARMUP_RUNS, iterations); i++) {
    await fn();
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }

  samples.sort((a, b) => a - b);
  const mean = samples.reduce((sum, x) => sum + x, 0) / samples.length;

  return {
    label,
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    mean: round(mean),
    n: samples.length,
  };
}
