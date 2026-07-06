// The single import site for the Rust crate. The `.server.ts` suffix is a
// convention (TanStack Start does not enforce it) — what actually keeps the
// native addon out of the browser is that this module is only reachable from
// server function handlers and server route handlers, which Start compiles
// out of the client bundle. The plugin's `options.ssr` gate is the backstop:
// if client-reachable code ever imports this module, the client build fails
// with a readable "Rust modules can only be imported server-side" error.
export { add, sumTo } from "../../native/src/lib.rs";
