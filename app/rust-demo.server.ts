// Server-only entry point for the native Rust addon. The `.server.ts` suffix
// keeps this (and the `.rs` import it pulls in) out of the client graph.
import { add, hashChain } from "../native/src/lib.rs";

export { add, hashChain };

// Same 6M-iteration workload as heavy.server.ts::heavyHashChain, but executed
// in Rust on napi-rs's Tokio worker pool (sized to CPU cores — see
// MEASUREMENTS.md §4). Kept here so both the /rust demo and the
// /slow-cpu-rust A/B route share a single import site for the native addon.
export const HEAVY_ITERATIONS = 6_000_000;

export interface RustHeavyResult {
  iterations: number;
  digest: string;
}

export async function heavyHashChainRust(): Promise<RustHeavyResult> {
  const digest = await hashChain(HEAVY_ITERATIONS);
  return { iterations: HEAVY_ITERATIONS, digest };
}
