// Server-only entry point for the native Rust addon.
//
// Astro has no `.server.ts` filename convention of its own — what keeps this
// module (and the `.rs` import it pulls in) out of the browser is that it is
// only imported from `.astro` frontmatter and API routes, which never ship to
// the client. The plugin's `options.ssr` gate is the backstop: if this module
// ever reached the client graph (e.g. imported from a hydrated island), the
// build fails with a readable error instead of leaking a native binary.
import { add, sumTo } from "../../native/src/lib.rs";

export { add, sumTo };
