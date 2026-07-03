// Server-only entry (`.server.ts`) that pulls in the native crate. The suffix
// keeps the `.rs` import out of the client graph.
import { add, sumTo } from "../native/src/lib.rs";

export { add, sumTo };
