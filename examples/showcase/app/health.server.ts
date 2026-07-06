// Server-only entry point for the `health` demo crate. The `.server.ts` suffix
// keeps this (and the `.rs` import it pulls in) out of the client graph.
//
// This is the multi-crate smoke test: `crates/health` is one of several
// independent crates under `crates/`, each its own napi-rs import site. If this
// route builds and serves, arbitrary per-demo crates do too.
import { add, sumTo } from "../crates/health/src/lib.rs";

export { add, sumTo };
