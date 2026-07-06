// Server-only entry point for the native Rust addon.
//
// Qwik has no `.server.ts` filename convention of its own — the suffix here is
// documentation, not enforcement. What keeps this module (and the `.rs` import
// it pulls in) out of the browser is that it is only imported from
// `routeLoader$` callbacks and route endpoints (`onGet`), which Qwik City runs
// exclusively on the server. The plugin's `options.ssr` gate is the backstop:
// if this module ever reached the client graph (e.g. imported from component
// render code or an event handler), the client build fails with a readable
// error instead of leaking a native binary.
import { add, sumTo } from "../../native/src/lib.rs";

export { add, sumTo };
