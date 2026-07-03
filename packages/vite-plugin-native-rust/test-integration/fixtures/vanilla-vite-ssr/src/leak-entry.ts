// Client-reachable module that imports a `.rs` file — the plugin must reject
// this at build time. Only ever built via vite.leak.config.ts.
import { add } from "../native/src/lib.rs";

export const two = add(1, 1);
