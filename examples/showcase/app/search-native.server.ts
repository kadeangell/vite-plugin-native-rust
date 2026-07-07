// Server-only entry point for the tantivy search crate. The `.server.ts`
// suffix keeps the `.rs` import out of the client graph.
//
// This is the showcase's *stateful* native import: the crate holds the index,
// reader, and query parser in a process-wide `OnceLock`, so `ensureIndex()`
// pays the one-time build (async, off the event loop) and `search()` is a
// sub-millisecond synchronous read of shared state on every later call.
export { ensureIndex, search } from "../crates/search/src/lib.rs";
export type { IndexStats, SearchHit } from "../crates/search/src/lib.rs";
