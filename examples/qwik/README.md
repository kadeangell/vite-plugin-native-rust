# Qwik City + vite-plugin-native-rust

A minimal [Qwik City](https://qwik.dev) app that imports a Rust crate directly
from server code:

```ts
// src/lib/rust.server.ts
import { add, sumTo } from "../../native/src/lib.rs";
```

Two server surfaces call the compiled napi-rs addon on every request:

- `/` — a page whose `routeLoader$` calls `add(2, 3)` (= 5) and
  `await sumTo(1000)` (= 500500) and renders the results.
- `/rust/` — a route endpoint (`onGet`) returning the same values as JSON.

Deployed at **https://vpnr-example-qwik.vercel.app** (Vercel Node function,
`nodejs24.x`).

**Verdict: dev and build work out of the box; the Vercel deploy needs one
honest accommodation.** Qwik City's official Vercel adapter is edge-only
(`.vc-config.json` `runtime: "edge"` is hard-coded in
`@builder.io/qwik-city/adapters/vercel-edge`), and edge functions cannot load
native addons. This example deploys through Qwik City's *generic Node
middleware* wrapped in a zero-config Vercel Node function instead — ~40 lines
of example-level wiring, no plugin changes.

## How the wiring works

- **`vite.config.ts`** — `rustPlugin()` before `qwikCity()` / `qwikVite()`.
- **`src/lib/rust.server.ts`** — the single import site for the `.rs` file.
  Qwik has no `.server.ts` filename convention; the suffix is documentation.
  What keeps the crate out of the browser is that the module is only imported
  from `routeLoader$` callbacks and route endpoints, which run exclusively on
  the server (see the optimizer notes below). The plugin's `options.ssr` gate
  is the backstop.
- **`src/routes/index.tsx`** — `routeLoader$` calls the Rust exports; the
  component renders the loader's serialized values.
- **`src/routes/rust/index.ts`** — `onGet` JSON endpoint. Deliberately *not*
  under `/api/` — on Vercel that prefix belongs to the functions directory and
  unmatched `/api/*` paths 404 before rewrites apply.
- **`adapters/vercel-node/vite.config.ts`** — the SSR build uses the generic
  `nodeServerAdapter` (not `vercelEdgeAdapter`) and emits two entries into
  `server/`: `entry.vercel-node.js` (bare `(req, res)` handler for Vercel) and
  `entry.node-server.js` (a listening `node:http` server for local preview).
- **`tsconfig.json`** — `"allowArbitraryExtensions": true` so TypeScript
  resolves the plugin-generated `native/src/lib.d.rs.ts` for the `.rs` import.
  `npm run typecheck` passes without a Rust toolchain because that file is
  committed.
- **`native/`** — a stock `npm create native-rust` crate (one sync `add`, one
  async `sumTo`), untouched.

## What Qwik's optimizer does with the `.rs` import (verified)

Qwik aggressively code-splits at `$` boundaries, and route modules *do* enter
the client build graph (route components ship to the browser for SPA
navigation). The load-bearing question was whether the `routeLoader$` callback
— and the `.rs` import it pulls in — leaks into the client pass. Verified on
Qwik 1.20 / Vite 7:

- **Loader segments are stripped from the client build.** With the top-level
  `import { add, sumTo } from "../lib/rust.server"` in `src/routes/index.tsx`,
  the client build completes and `dist/` contains **zero** references to
  `rust.server`, the `.rs` module, or the addon (the only `sumTo` match in any
  client chunk is the page's literal display text). The optimizer replaces the
  loader callback with a QRL reference and tree-shakes the server-only import
  out of the client graph before the plugin's `load` hook ever sees it.
- **The ssr gate fires the moment the import becomes client-reachable.**
  Temporarily adding `<button onClick$={() => console.log(add(1, 2))}>` (event
  handlers ship to the browser) fails `vite build` with the plugin's readable
  error:

  > [vite-rust] Could not load …/native/src/lib.rs?rust (imported by
  > src/lib/rust.server.ts): Rust modules can only be imported server-side —
  > import this only from a .server.ts module (or another server-only module),
  > never from code that can reach the client bundle.

  In Qwik terms: keep `.rs` imports reachable only from `routeLoader$` /
  `routeAction$` / `server$` callbacks and route endpoints (`onGet` etc.),
  never from component render code or `$`-wrapped event handlers.

## Run it locally

```bash
# from the monorepo root
npm install
npm run build -w vite-plugin-native-rust

cd examples/qwik
npm run dev          # first request compiles the crate (~30s cold), then instant
curl localhost:5173/rust/   # {"add":5,"sumTo":500500,...}

npm run build        # client build → dist/, SSR release build → server/
npm run preview      # node server/entry.node-server.js on :3000
curl localhost:3000/rust/
```

Requires a Rust toolchain (`cargo` on `PATH`).

## How the addon travels to Vercel (what we verified)

The SSR build emits the addon at the `server/` output root, sibling to the
chunk that references it via
`new URL("qwikdemo-<hash>.node", import.meta.url)` — the statically-analyzable
pattern `@vercel/nft` recognizes. `api/entry.ts` re-exports the built handler
(`export { default } from "../server/entry.vercel-node.js"`), so Vercel's Node
builder traces from there through the server chunks to the addon and packages
everything at the same relative paths inside the function. The built server
externalizes only Node built-ins and `undici`; everything else (Qwik, Qwik
City, the app) is bundled.

Request flow on Vercel: static assets are served from `dist/`
(`outputDirectory`) by the static layer; everything else falls through the
catch-all rewrite in `vercel.json` to `/api/entry`, where Qwik City's Node
middleware routes it (`getOrigin` reconstructs the public origin from
`x-forwarded-*` headers).

## Deploying

The Vercel project (`vpnr-example-qwik`) has **Root Directory** =
`examples/qwik` with **"Include files outside the Root Directory"** enabled
(the example lives in an npm workspace and resolves `vite-plugin-native-rust`
from the monorepo), and **Node.js version** = 24.x. `vercel.json` routes
install/build through `scripts/vercel-install.sh` and `scripts/vercel-build.sh`,
which install a minimal stable Rust toolchain into `node_modules/.cache`
(persisted by Vercel's build cache) and build the plugin package before the
example. See [docs/deployment-vercel.md](../../docs/deployment-vercel.md) for
the full rationale; the scripts are the monorepo variant described there.

```bash
vercel deploy --prod --yes    # from the monorepo root
curl -s https://vpnr-example-qwik.vercel.app/rust/
# {"add":5,"sumTo":500500,"runtime":"v24.x.x"}
```

## Caveats

- **The official Vercel adapter cannot be used.** `vercelEdgeAdapter` hard-codes
  `runtime: "edge"` and esbuild-bundles for the edge runtime, which cannot load
  `.node` addons at all. Its `target: "node"` option only changes module
  resolution, not the deploy runtime. If Qwik City ships a serverless/Node
  Vercel adapter in the future, the `api/entry.ts` + rewrite wiring here
  collapses to that adapter.
- **Keep the JSON endpoint (and any Rust route) out of `/api/`.** Vercel
  reserves that path for the functions directory; unmatched `/api/*` requests
  404 instead of reaching the catch-all rewrite.
- **The first dev request pauses** while the crate compiles (~30 s cold, watch
  for `[vite-rust] compiling crate "qwikdemo"`); later requests hit the
  content-hash cache.
- **SSG would silently defeat the demo.** The adapter's SSG pass here emits
  only `404.html` and `sitemap.xml`; the Rust routes stay dynamic. If you add
  SSG `include` patterns covering a route whose loader calls Rust, the values
  are baked in at build time on the build machine — it *works*, but
  demonstrates nothing.
- **Qwik versions.** Validated on Qwik / Qwik City **1.20 (stable)** with
  Vite 7. Qwik 2.0 (`@qwik.dev/*`) is still in beta and was not validated
  here.
- **Monorepo-only TypeScript cast.** `adapters/vercel-node/vite.config.ts`
  casts `baseConfig` because this repo hoists Vite 6 for other examples while
  this example nests Vite 7, so qwik-city's `extendConfig` types resolve
  against a different (structurally identical) Vite copy. A standalone app on
  one Vite version does not need it.
