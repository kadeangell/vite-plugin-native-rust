# example-sveltekit

A minimal SvelteKit app whose server `load` imports a Rust crate directly:

```ts
// src/lib/server/rust.ts
import { add, sumTo } from '../../../native/src/lib.rs';
```

`src/routes/+page.server.ts` calls `add(2, 3)` (sync) and `await sumTo(1000)`
(async, off the event loop) and the page renders **5** and **500500**.

## Run it

```bash
# from the monorepo root
npm install
npm run build -w vite-plugin-native-rust   # build the plugin dist the example consumes

cd examples/sveltekit
npm run dev        # first request compiles the crate (~20–30s cold), then instant
npm run build      # release build + @sveltejs/adapter-vercel output
npm run preview    # serve the production build locally
```

Requires a Rust toolchain (`cargo` on `PATH`); the crate in `native/` was
scaffolded with `npm create native-rust`.

## How it's wired

- **`vite.config.ts`** — `rustPlugin()` sits before `sveltekit()`. This scaffold
  (sv 0.16 / SvelteKit 2.63+) has no `svelte.config.js`; the adapter is passed to
  the `sveltekit()` Vite plugin directly.
- **`src/lib/server/rust.ts`** — the single import site for the `.rs` file.
  `$lib/server/` is SvelteKit's server-only convention: client-reachable code
  cannot import it, so the native addon can never leak into the browser bundle.
- **`src/routes/+page.server.ts`** — server `load` calls the Rust exports.
  `export const prerender = false` is explicit (it's also SvelteKit's default):
  a prerendered page would bake the Rust results in at build time instead of
  running them per-request.
- **`tsconfig.json`** — `"allowArbitraryExtensions": true`, so TypeScript
  resolves the plugin-generated `native/src/lib.d.rs.ts` for the `.rs` import.
  `svelte-check` passes with 0 errors.

## What worked out of the box (verified 2026-07)

- **Vite 8 (Rolldown) + SvelteKit 2.63 + Svelte 5** — the plugin's
  `emitFile` + `ROLLUP_FILE_URL` codegen renders correctly under Rolldown; the
  server chunk references the addon as
  `new URL("../../sveltedemo-<hash>.node", import.meta.url)` and it resolves.
- **The `options.ssr` gate under SvelteKit's client+server builds.** The client
  build never receives the addon (zero `.node` files or references in
  `.svelte-kit/output/client`). Importing the `.rs` from a client-reachable
  component fails the build with the plugin's readable error — verified by
  temporarily importing it from a plain `+page.svelte`:

  > Rust modules can only be imported server-side — import this only from a
  > .server.ts module (or another server-only module), never from code that can
  > reach the client bundle.

  In SvelteKit terms: keep `.rs` imports inside `$lib/server/` (or
  `+page.server.ts` / `+server.ts`) and you get two independent guards —
  SvelteKit's server-only module rule and the plugin's gate.
- **`@sveltejs/adapter-vercel` v6 did NOT drop the addon.** The anticipated risk
  was the adapter re-bundling Vite's server output and losing the beside-the-chunk
  `.node` placement. In current adapter-vercel the serverless (Node runtime)
  path does **not** esbuild-rebundle: it traces the built server with
  `@vercel/nft`, which recognizes the `new URL("….node", import.meta.url)`
  pattern and copies the addon into
  `.vercel/output/functions/[…]/catchall.func/` at the same relative path.
  **No adapter `external`/`includeFiles` config and no postbuild copy script
  were needed.** (The `edge` runtime *does* esbuild-bundle and cannot load
  native addons at all — don't set `runtime: 'edge'` on routes that touch Rust.)

## Caveats

- **Adapter runtime pin.** `adapter({ runtime: 'nodejs24.x' })` is set in
  `vite.config.ts` because adapter-vercel only auto-detects the runtime when
  the *local* Node is 20/22/24; on any other Node major the production build
  fails with "Unsupported Node.js version". Pinning also keeps local builds and
  Vercel deploys on the same runtime.
- **First dev request pauses.** The first request that touches the crate runs a
  cold `cargo` debug build (~20–30s; watch the `[vite-rust] compiling crate…`
  log line). Every later request hits the content-hash cache (sub-millisecond).
- **A harmless duplicate addon copy appears in the Vite server output** at
  `.svelte-kit/output/server/entries/pages/sveltedemo-<hash>.node` alongside
  the real one at `.svelte-kit/output/server/`. It comes from the plugin's
  post-write guarantee, which assumes chunks resolve the addon as a *sibling*,
  while SvelteKit's nested chunk layout references it via `../../`. The copy is
  never traced into the deployed function — it's ~500 kB of dead weight in the
  local build dir only.
- **Prerendering must stay off for Rust routes.** SvelteKit's default is
  already `prerender = false`; if you enable prerendering globally, exclude any
  route whose `load` calls Rust at request time (or accept build-time-frozen
  values).

## Vercel deploy

Project `vpnr-example-sveltekit`, Root Directory `examples/sveltekit` with
"Include source files outside of the Root Directory" enabled (the example lives
in an npm workspace and resolves `vite-plugin-native-rust` from the monorepo).

- **`vercel.json`** points install/build at `scripts/vercel-install.sh` and
  `scripts/vercel-build.sh` (Vercel rejects inline commands > 256 chars).
- **`scripts/vercel-install.sh`** — `npm install` at the repo root, then
  installs a minimal stable Rust toolchain into `node_modules/.cache/{cargo,rustup}`
  (the Vercel build image ships rustup but no default toolchain; the cache dir
  rides Vercel's build cache so warm builds skip the download).
- **`scripts/vercel-build.sh`** — re-exports the cargo PATH (install/build run
  in separate shells), builds the plugin dist, then this example. The adapter
  writes the Build Output API directory at `.vercel/output`, which Vercel
  deploys as-is.

```bash
# from the repo root, after `vercel link --yes --project vpnr-example-sveltekit`
vercel deploy --prod --yes
```
