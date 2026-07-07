// Bench slot for the "search" demo: tantivy (Rust, via the plugin) vs
// minisearch (best-in-class pure JS) over the identical 10,000-doc corpus,
// identical queries, comparable per-hit work (ranked hits + highlighted
// snippet).
//
// Index builds are excluded from per-query timings — both indexes are built
// once per process before any query row runs — and reported as their own
// rows (n=1: a one-time cost measured at first build, not a timeIt run).
import type { BenchSuite } from "../benchmarks.server";
import { timeIt, type BenchResult } from "../lib/bench.server";
import { ensureMiniIndex, searchMini } from "../search-minisearch.server";
import { ensureIndex, search } from "../search-native.server";

// Multi-term queries that hit the corpus vocabulary in different shapes
// (common terms, rarer terms, title-heavy matches).
const QUERIES = [
  "rust memory safety",
  "postgresql query planning",
  "tantivy snippet highlighting",
] as const;

// Small on purpose: /benchmarks runs live per request, and warm queries are
// fast enough that 15 samples give a stable p50 without hurting the page.
const ITERATIONS = 15;
const RESULT_LIMIT = 10;

function oneTimeCostRow(label: string, ms: number): BenchResult {
  const rounded = Number(ms.toFixed(3));
  return { label, p50: rounded, p95: rounded, mean: rounded, n: 1 };
}

export const suite: BenchSuite | null = {
  id: "search",
  title: "Full-text search — tantivy vs minisearch (same 10,000-doc corpus)",
  run: async (): Promise<BenchResult[]> => {
    // Build both indexes before timing any query, and surface the one-time
    // build cost honestly as its own rows.
    const stats = await ensureIndex();
    const miniStats = ensureMiniIndex();

    const rows: BenchResult[] = [
      oneTimeCostRow("tantivy: index build (one-time, per process)", stats.buildMs),
      oneTimeCostRow(
        "minisearch: index build (one-time, per process)",
        miniStats.buildMs,
      ),
    ];

    for (const query of QUERIES) {
      rows.push(
        await timeIt(
          `tantivy: "${query}"`,
          () => search(query, RESULT_LIMIT),
          ITERATIONS,
        ),
      );
      rows.push(
        await timeIt(
          `minisearch: "${query}"`,
          () => searchMini(query, RESULT_LIMIT),
          ITERATIONS,
        ),
      );
    }
    return rows;
  },
};
