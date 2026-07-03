import { createHash } from "node:crypto";

const ITERATIONS = 6_000_000;
const SEED = "vite-rust-import-plugin";

export interface HeavyResult {
  iterations: number;
  digest: string;
}

/**
 * A genuinely CPU-bound synchronous workload: iteratively re-hash a buffer
 * with SHA-256 a few million times. Calibrated to take roughly 2-4 seconds.
 *
 * This is the function that will later be ported to Rust and compiled to a
 * native Node addon by the Vite plugin this project exists to test.
 */
export function heavyHashChain(): HeavyResult {
  let buffer: Buffer = Buffer.from(SEED, "utf8");
  for (let i = 0; i < ITERATIONS; i++) {
    buffer = createHash("sha256").update(buffer).digest();
  }
  return { iterations: ITERATIONS, digest: buffer.toString("hex") };
}
