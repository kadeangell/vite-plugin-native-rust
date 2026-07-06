// @ts-check
import vercel from "@astrojs/vercel";
import { defineConfig } from "astro/config";
import { rustPlugin } from "vite-plugin-native-rust";

// `output: "server"` makes every page on-demand rendered (no prerendering) —
// the Rust addon is called at request time inside the Vercel function, so the
// pages must not be turned into static HTML at build time.
//
// `rustPlugin()` goes in `vite.plugins`; Astro forwards it into every Vite
// pass it runs (dev SSR, the client build, and the server build). The plugin
// gates `.rs` loads on `options.ssr`, so only the server-side passes compile
// and load the crate.
export default defineConfig({
  output: "server",
  adapter: vercel(),
  vite: {
    plugins: [rustPlugin()],
  },
});
