// The event-loop experiment behind the /hashing "run experiment" button.
// Server-only.
//
// Runs the SAME call pattern twice — `Promise.all` of CONCURRENCY password
// hashes — once against the deliberately-sync export and once against the
// async export, while a probe measures whether the event loop is still alive.
//
// How the probe works (and why it is honest):
//   A loop of `setTimeout(PROBE_INTERVAL_MS)` ticks records, for each tick,
//   how much LATER than requested the timer actually fired ("lag"). A healthy
//   loop ticks every ~5 ms with ~0 lag. While a sync native call holds the
//   main thread, timers cannot fire AT ALL — so the probe goes silent for the
//   whole stall and its next tick carries the entire blocked span as one giant
//   lag sample. That silence-then-spike is not an artifact; it is exactly what
//   every other request experiences on a blocked server: nothing runs late,
//   nothing runs at all. `maxLagMs` therefore reads as "the longest stretch
//   the server was unable to run a 5 ms timer."

import { hashPassword, hashPasswordSync } from "./hashing.server";

export const CONCURRENCY = 4;
const PROBE_INTERVAL_MS = 5;

export interface LoopProbeStats {
  ticks: number; // how many times the 5 ms probe timer managed to fire
  maxLagMs: number; // worst observed delay beyond the requested 5 ms
  meanLagMs: number;
}

export interface ExperimentRun {
  mode: "sync" | "async";
  wallMs: number; // total time for all CONCURRENCY hashes to complete
  probe: LoopProbeStats;
}

export interface ExperimentResult {
  concurrency: number;
  probeIntervalMs: number;
  sync: ExperimentRun;
  async: ExperimentRun;
}

const round = (ms: number): number => Number(ms.toFixed(1));

function summarize(lags: readonly number[]): LoopProbeStats {
  if (lags.length === 0) {
    return { ticks: 0, maxLagMs: 0, meanLagMs: 0 };
  }
  const max = lags.reduce((a, b) => Math.max(a, b), 0);
  const mean = lags.reduce((a, b) => a + b, 0) / lags.length;
  return { ticks: lags.length, maxLagMs: round(max), meanLagMs: round(mean) };
}

// Runs `work` while sampling event-loop lag; returns wall time + probe stats.
async function probeWhile(work: () => Promise<unknown>): Promise<{
  wallMs: number;
  probe: LoopProbeStats;
}> {
  const lags: number[] = [];
  let stopped = false;

  const probeLoop = (async () => {
    while (!stopped) {
      const requestedAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
      const lag = performance.now() - requestedAt - PROBE_INTERVAL_MS;
      lags.push(Math.max(0, lag));
    }
  })();

  const start = performance.now();
  try {
    await work();
  } finally {
    stopped = true;
  }
  const wallMs = performance.now() - start;
  await probeLoop;

  return { wallMs: round(wallMs), probe: summarize(lags) };
}

// Both modes issue the hashes identically — Promise.all of CONCURRENCY calls.
// The only difference is the export shape. The sync export still "returns a
// value synchronously", so each call is wrapped in a resolved-promise tick to
// make the call sites symmetrical; that wrapper adds microtask scheduling
// (~microseconds), not concurrency — the four sync hashes still run
// back-to-back on the main thread.
function runHashes(mode: "sync" | "async", password: string): Promise<unknown> {
  const tasks = Array.from({ length: CONCURRENCY }, () =>
    mode === "sync"
      ? Promise.resolve().then(() => hashPasswordSync(password))
      : hashPassword(password),
  );
  return Promise.all(tasks);
}

export async function runEventLoopExperiment(
  password: string,
): Promise<ExperimentResult> {
  // One untimed warm-up hash so lazy init (addon load, first-touch memory)
  // isn't billed to either mode.
  await hashPassword(password);

  const syncRun = await probeWhile(() => runHashes("sync", password));
  const asyncRun = await probeWhile(() => runHashes("async", password));

  return {
    concurrency: CONCURRENCY,
    probeIntervalMs: PROBE_INTERVAL_MS,
    sync: { mode: "sync", ...syncRun },
    async: { mode: "async", ...asyncRun },
  };
}
