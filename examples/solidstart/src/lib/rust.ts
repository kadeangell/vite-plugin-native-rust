"use server";

// The single import site for the Rust crate. The module-level "use server"
// directive makes this file server-only: SolidStart's client pass replaces the
// whole module with RPC stubs and never follows this import, so the native
// addon cannot leak into the browser bundle. The plugin's options.ssr gate is
// the backstop if anything ever routes it toward the client graph.
import { add, sumTo } from "../../native/src/lib.rs";

export interface RustDemoResult {
  /** Sync #[napi] fn — runs on the Node main thread. Expected: 5. */
  add: number;
  /** Async #[napi] fn — runs off the event loop on napi's thread pool. Expected: 500500. */
  sumTo: number;
  /** Node runtime that executed the Rust call (proves it ran server-side). */
  runtime: string;
}

export async function runRustDemo(): Promise<RustDemoResult> {
  return {
    add: add(2, 3),
    sumTo: await sumTo(1000),
    runtime: `node ${process.version}`,
  };
}
