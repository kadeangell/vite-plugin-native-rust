// The Nitro-side Rust call site.
//
// Everything under `server/` is bundled by Nitro's own Rollup pass, not by
// Vite — this import only works because `nuxt.config.ts` registers the plugin
// in `nitro.rollupConfig.plugins` (adapted via ../../nitro-rust.ts). Nitro's
// bundle is server-only by construction, so there is no client-leak risk here.
import { add, sumTo } from "../../native/src/lib.rs";

export default defineEventHandler(async () => {
  return {
    add: add(2, 3), // expected: 5
    sumTo: await sumTo(1000), // expected: 500500
    runtime: process.version,
    where: "nitro server/api route",
  };
});
