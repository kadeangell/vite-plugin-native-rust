// Bench slot for the "transform" demo. The demo agent replaces the null export with
// its BenchSuite (see benchmarks.server.ts contract). Owned exclusively by
// that demo — other agents must not touch this file.
import type { BenchSuite } from "../benchmarks.server";

export const suite: BenchSuite | null = null;
