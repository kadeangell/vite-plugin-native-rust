// The app-layer (Vite-side) Rust call site.
//
// A Nuxt plugin with the `.server.ts` suffix is Nuxt's app-layer server-only
// convention: it runs during SSR only, and the client's generated plugin
// manifest never imports it — so this `.rs` import can never reach the browser
// bundle. (The Vite plugin's `options.ssr` gate is the backstop: importing the
// `.rs` from client-reachable app code fails the build with a readable error.)
//
// The Rust results are stashed in `useState`, which Nuxt serializes into the
// page payload — the page renders them during SSR and the client hydrates the
// same values.
import { add, sumTo } from "../../native/src/lib.rs";

export interface RustSsrValues {
  add: number;
  sumTo: number;
  computedAt: string;
}

export default defineNuxtPlugin(async () => {
  const rust = useState<RustSsrValues | null>("rust-ssr", () => null);
  rust.value = {
    add: add(2, 3), // sync #[napi] fn — runs on the main thread
    sumTo: await sumTo(1000), // async #[napi] fn — Tokio pool, off the event loop
    computedAt: new Date().toISOString(),
  };
});
