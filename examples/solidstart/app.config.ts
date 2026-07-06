import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "@solidjs/start/config";
import { rustPlugin } from "vite-plugin-native-rust";

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
    // ── Workaround 1/2: keep `import.meta.url` real in Nitro's bundle. ──
    // Nitro's rollup pass rewrites every `import.meta.<x>` to
    // `globalThis._importMeta_.<x>`, whose `url` is the *entry* (index.mjs at
    // the function root) — that breaks the plugin's emitted
    // `new URL("../soliddemo-<hash>.node", import.meta.url)` loader, which is
    // relative to the chunk that contains it. `replace` entries are merged
    // last, and @rollup/plugin-replace matches longest-key-first, so this
    // identity mapping wins over Nitro's `import.meta.` rewrite for exactly
    // `import.meta.url` and leaves everything else stubbed as Nitro intends.
    replace: {
      "import.meta.url": "import.meta.url",
    },
    // Nitro's esbuild step defaults to target es2019, where `import.meta` is
    // "not available" — esbuild would stub it to an empty object and break the
    // loader we just preserved. The function runs on Node 24; es2022 keeps
    // `import.meta` intact.
    esbuild: {
      options: {
        target: "es2022",
      },
    },
    // ── Workaround 2/2: ship the addon into the function bundle. ────────
    // vinxi's ssr/server-fns Vite passes emit the compiled `.node` beside
    // their chunks (.vinxi/build/{ssr,server-fns/_server}/), but Nitro's
    // rollup pass re-bundles those chunks into chunks/nitro/nitro.mjs and
    // does not treat the addon as an asset, so it never reaches
    // .vercel/output. The loader (with real `import.meta.url`, above)
    // resolves `../<name>.node` from chunks/nitro/ → chunks/<name>.node, so
    // copy it there once Nitro finishes.
    hooks: {
      compiled: async (nitro: {
        options: { output: { serverDir: string } };
      }) => {
        const ssrOut = join(process.cwd(), ".vinxi/build/ssr");
        const chunksDir = join(nitro.options.output.serverDir, "chunks");
        const addons = (await readdir(ssrOut)).filter((f) =>
          f.endsWith(".node"),
        );
        if (addons.length === 0) {
          throw new Error(
            "[example-solidstart] no compiled .node addon found in .vinxi/build/ssr — did the rust plugin run in the ssr pass?",
          );
        }
        await mkdir(chunksDir, { recursive: true });
        for (const addon of addons) {
          await copyFile(join(ssrOut, addon), join(chunksDir, addon));
          console.log(
            `[example-solidstart] copied ${addon} into the Vercel function (chunks/)`,
          );
        }
      },
    },
  },
});
