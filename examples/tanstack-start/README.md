# TanStack Start + vite-plugin-native-rust

A minimal [TanStack Start](https://tanstack.com/start) app that imports a Rust
crate directly from server code:

```ts
// src/server/rust.server.ts
export { add, sumTo } from "../../native/src/lib.rs";
```

Two server surfaces call the compiled napi-rs addon on every request:

- `/` — a route whose loader calls a **server function**
  (`createServerFn`) that runs `add(2, 3)` (= 5) and `await sumTo(1000)`
  (= 500500) and renders the results.
- `/api/rust` — a **server route** (a file route with only `server.handlers`)
  returning the same values as JSON.

Deployed at **https://vpnr-example-tanstack-start.vercel.app** (Vercel
Functions via the Nitro Vite plugin).

## How the wiring works

- **`vite.config.ts`** — plugin order matters:
  `[rustPlugin(), tanstackStart(), nitro(), viteReact()]`. TanStack Start is a
  plain Vite plugin these days (no vinxi); the [Nitro Vite
  plugin](https://v3.nitro.build/) is its deploy layer — locally it produces a
  Node server (`.output/server/index.mjs`), on Vercel it auto-selects the
  `vercel` preset and writes the Build Output API directory at
  `.vercel/output`.
- **`src/server/rust.server.ts`** — the single import site for the `.rs` file.
  Unlike Astro, the `.server.` suffix here is **enforced**: TanStack Start's
  own `import-protection` plugin denies any `**/*.server.*` import that is
  reachable from the client environment, with a full import trace. The
  plugin's `options.ssr` gate is the second, independent guard (see below).
- **`src/routes/index.tsx`** — imports the server module at top level, but
  only the `createServerFn` handler references it. Start compiles the handler
  (and the imports only it uses) out of the client bundle, so the `.rs` module
  never enters the client graph — the browser gets an RPC stub that fetches
  the result over HTTP.
- **`src/routes/api/rust.ts`** — a server route (`server.handlers.GET`); it
  has no component, so it never ships client code at all.
- **`tsconfig.json`** — `"allowArbitraryExtensions": true` lets TypeScript
  resolve the plugin-generated `native/src/lib.d.rs.ts` for the `.rs` import.
  That file is committed, so `npm run typecheck` passes without a Rust
  toolchain.
- **`native/`** — a stock `npm create native-rust` crate (one sync `add`, one
  async `sumTo`), untouched.

## Run it locally

```bash
# from the monorepo root
npm install
npm run build -w vite-plugin-native-rust

cd examples/tanstack-start
npm run dev
curl localhost:3000/api/rust     # {"add":5,"sumTo":500500,...}

npm run build                    # release build → .output/ (node-server preset)
node .output/server/index.mjs    # serve the production build
curl localhost:3000/api/rust
```

Requires a Rust toolchain (`cargo` on `PATH`).

## The server-only gate (both layers verified)

Importing the `.rs` from client-reachable code fails the build **twice over**:

1. **Start's import-protection** fires first if you go through the
   `*.server.*` module — with an import trace and fix suggestions:

   > [import-protection] Import denied in client environment
   > Denied by file pattern: \*\*/\*.server.\*

2. **The plugin's `options.ssr` gate** fires if you bypass the naming
   convention and import the `.rs` directly from a component:

   > Rust modules can only be imported server-side — import this only from a
   > .server.ts module (or another server-only module), never from code that
   > can reach the client bundle.

Both were captured by deliberately referencing `add()` inside the client
component and building; the clean example keeps the import behind the server
function handler, where Start's compiler strips it from the client bundle
(verified: zero `.node`/addon references in `.output/public`).

## How the addon survives Nitro's re-bundle (the interesting part)

TanStack Start + Nitro builds in **two passes**: Vite first builds the SSR
service (where the plugin compiles the crate and emits the `.node` as an
asset), then Nitro runs a second Rollup pass that re-bundles that output into
the final server build. That second pass **drops the emitted addon asset** —
the chunk still references `new URL("../tanstackdemo-<hash>.node",
import.meta.url)` but the file itself isn't copied.

The plugin's post-write guarantee catches this: during the Nitro pass it
detects a written chunk referencing an addon that's missing from the output
and copies the binary to the exact path the chunk resolves. You'll see:

```
[plugin vite-rust] [vite-rust] recovered dropped addon "tanstackdemo-<hash>.node"
  → .output/server/tanstackdemo-<hash>.node
  (referenced by "_ssr/rust.server-<hash>.mjs" but missing from the written output)
```

In the SvelteKit and Astro examples this recovery is a false alarm (the addon
was already in place); **here it is load-bearing** — without it the production
build would crash at require time. No example-level workaround was needed, but
this is the first framework where the guarantee actually earns its keep.

## Caveats

- **The first dev request can exceed Nitro's 60s module-runner timeout.** In
  dev, Nitro fetches SSR modules over a transport with a 60-second invoke
  timeout; a cold `cargo` debug build that runs longer aborts that first
  request with a 500 (`transport invoke timed out after 60000ms`). The compile
  keeps running and completes; **restart the dev server** (or just wait for
  the compile and reload once the module-runner cache expires) and every
  request after that hits the content-hash cache instantly. Warm-cache dev
  startups never see this. Workaround if it bites you: run a one-off
  `npm run build` first to prime the cache, or `cargo build` in `native/`.
- **Prerendering would defeat the demo.** These routes render on demand; if
  you enable Start's prerendering for a route that calls Rust, the values are
  baked at build time (it works, but demonstrates nothing).
- **Keep `.rs` imports behind server functions, server routes, or
  `*.server.*` modules.** Anything else is a build error — by design, from
  both Start and the plugin.

## Vercel deploy

Project `vpnr-example-tanstack-start`, Root Directory `examples/tanstack-start`
with "Include source files outside of the Root Directory" enabled (the example
lives in an npm workspace and resolves `vite-plugin-native-rust` from the
monorepo).

- **`vercel.json`** points install/build at `scripts/vercel-install.sh` and
  `scripts/vercel-build.sh` (Vercel rejects inline commands > 256 chars).
- **`scripts/vercel-install.sh`** — `npm install` at the repo root, then
  installs a minimal stable Rust toolchain into
  `node_modules/.cache/{cargo,rustup}` (the Vercel build image ships rustup
  but no default toolchain; the cache dir rides Vercel's build cache so warm
  builds skip the download).
- **`scripts/vercel-build.sh`** — re-exports the cargo PATH (install/build run
  in separate shells), builds the plugin dist, then this example. The Nitro
  plugin detects Vercel and writes the Build Output API directory at
  `.vercel/output`, which Vercel deploys as-is.

```bash
# from the repo root, after `vercel link --yes --project vpnr-example-tanstack-start`
vercel deploy --prod --yes
curl -s https://vpnr-example-tanstack-start.vercel.app/api/rust
# {"add":5,"sumTo":500500,...}
```
