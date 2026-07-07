import { defineConfig } from "@solidjs/start/config";
import { rustPlugin } from "vite-plugin-native-rust";
import {
  nitroPreserveImportMeta,
  nitroShipAddons,
} from "vite-plugin-native-rust/nitro";

export default defineConfig({
  // vinxi runs THREE Vite passes (routers): "client", "ssr", and
  // "server-function". A plain `vite: {}` object applies to all of them, which
  // is what we want: the ssr and server-function passes need the plugin to
  // compile the `.rs` import, and the client pass needs it so a `.rs` module
  // that leaks toward the browser fails loudly (the plugin's options.ssr gate)
  // instead of shipping a native binary.
  vite: {
    plugins: [rustPlugin()],
  },
  server: {
    // Nitro's Vercel preset: `vinxi build` writes the Build Output API
    // directory at .vercel/output, which Vercel deploys as-is and
    // `npm run preview` serves locally.
    preset: "vercel",
    // Pin the function runtime; napi-rs is happy on Node 24.
    vercel: {
      functions: {
        runtime: "nodejs24.x",
      },
    },
    // ── Nitro accommodation 1/2: keep `import.meta.url` real. ──────────────
    // The rust plugin runs in vinxi's VITE passes, so the chunks Nitro
    // re-bundles already contain the resolved loader
    // `new URL("../soliddemo-<hash>.node", import.meta.url)` — chunk-relative.
    // Nitro's rollup pass would rewrite `import.meta.url` to the entry-URL
    // stub `globalThis._importMeta_.url` (breaking the relative resolution),
    // and its esbuild step (target es2019) would stub `import.meta` to `{}`
    // entirely. This helper fragment exempts exactly `import.meta.url` from
    // the stub (identity `replace` entry; Nitro merges user entries last and
    // @rollup/plugin-replace matches longest-key-first) and raises the
    // esbuild target to es2022. See the plugin's docs/nitro.md.
    ...nitroPreserveImportMeta(),
    // ── Nitro accommodation 2/2: ship the addon into the function bundle. ──
    // Nitro's rollup pass re-bundles vinxi's ssr output into
    // chunks/nitro/nitro.mjs and does not treat the `.node` addon as an
    // asset, so it never reaches .vercel/output on its own. This Nitro module
    // copies it (on the `compiled` hook, registered ADDITIVELY — a user-level
    // `hooks.compiled` would replace the vercel preset's own hook and break
    // the deploy) to <serverDir>/chunks/, where the preserved chunk-relative
    // loader `../<name>.node` resolves from chunks/nitro/nitro.mjs.
    modules: [
      nitroShipAddons({ from: ".vinxi/build/ssr", to: "chunks", required: true }),
    ],
  },
});
