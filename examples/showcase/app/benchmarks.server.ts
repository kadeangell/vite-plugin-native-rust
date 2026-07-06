// The benchmark registry the /benchmarks page renders. Server-only.
//
// CONTRACT for demo agents:
//   Each demo contributes ONE BenchSuite. Add it to `BENCHMARK_SUITES` below
//   (import your suite from your demo's *.server.ts and append it). The
//   /benchmarks loader calls `run()` for every registered suite and renders the
//   returned rows in a table under `title`. `run()` should use `timeIt` from
//   lib/bench.server.ts so every row is measured the same honest way. Keep
//   `run()` cheap enough to execute per-request (small iteration counts / small
//   inputs) — this page runs them live.

import type { BenchResult } from "./lib/bench.server";

export interface BenchSuite {
  id: string; // stable key, e.g. "search"
  title: string; // section heading, e.g. "Full-text search — tantivy vs minisearch"
  run: () => Promise<BenchResult[]>; // one row per implementation being compared
}

// Each demo owns exactly one slot file under app/benches/ (conflict-free
// parallel authoring); a slot exporting null renders nothing.
import { suite as search } from "./benches/search.server";
import { suite as images } from "./benches/images.server";
import { suite as transform } from "./benches/transform.server";
import { suite as hashing } from "./benches/hashing.server";

export const BENCHMARK_SUITES: readonly BenchSuite[] = [
  search,
  images,
  transform,
  hashing,
].filter((s): s is BenchSuite => s !== null);
