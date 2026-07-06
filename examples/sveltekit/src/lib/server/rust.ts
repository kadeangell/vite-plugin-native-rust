// Server-only entry point for the native Rust addon.
//
// This module lives in `$lib/server/`, which SvelteKit refuses to let any
// client-reachable code import — so the `.rs` import below can never leak into
// the browser bundle. The plugin's own `options.ssr` gate is a second, plugin-
// level backstop: if a `.rs` import somehow reached the client graph, the build
// would fail with a readable error instead of shipping a native binary to the
// browser.
import { add, sumTo } from '../../../native/src/lib.rs';

export { add, sumTo };
