# Vercel packaging recon — Phase 0 findings

Goal of this phase: answer the V3 mitigation-ladder question **before any
deploy**, by wiring in `@vercel/react-router` and running `vercel build`
locally, then reading the resulting `.vercel/output/` and the builder source.

**Headline: Rung 1 holds. Zero codegen or config changes are needed for the
addon to be packaged correctly.** `@vercel/nft` traces our build-mode
`new URL("native-<hash>.node", import.meta.url)` and copies the addon into the
function at the same relative path as the server chunk. Verified for the
single-bundle case *and* the bundle-split case (two Rust routes in two
functions, each getting its own correctly-hashed copy).

All work done on: macOS arm64 (Darwin 25.5.0), Node v25.8.1, Vercel CLI
50.33.0, `@vercel/react-router` (preset) 1.3.1, `@vercel/remix-builder`
(the CLI's builder) 5.7.0. **No deploy, no link** — `vercel build --yes` ran
fully offline and never prompted for a project.

---

## What was wired in

- `npm i -D @vercel/react-router` (1.3.1, + 37 transitive dev deps).
- `react-router.config.ts` now imports `vercelPreset` from
  `@vercel/react-router/vite` and sets `presets: [vercelPreset()]`.
- `.gitignore` gains `.vercel/`.
- `npx tsc --noEmit` → clean. `npm run build` → clean.
  `vercel build --yes` → `Build Completed in .vercel/output [2s]`, exit 0.

The preset is non-breaking: plain `npm run build` still succeeds; the only
visible change is that the server bundle now lands in a per-config subdirectory
(`build/server/nodejs_<base64url(config)>/`) instead of `build/server/`.

---

## 3a. What the preset produced

`vercel build` wrote `.vercel/output/` (Build Output API v3):

```
.vercel/output/
├── config.json                 # routing table (filesystem handler + SPA fallback)
├── diagnostics/cli_traces.json # builder = @vercel/remix-builder 5.7.0
├── functions/
│   ├── index.func/             # REAL function (only .vc-config.json inside)
│   ├── api/hello.func/         # REAL function, same bundle, own .vc-config.json
│   ├── rust.func         -> index.func   (symlink)
│   ├── slow-cpu.func     -> index.func   (symlink)
│   ├── slow-cpu-rust.func-> index.func   (symlink)
│   ├── slow-io.func      -> index.func   (symlink)
│   └── static.func       -> index.func   (symlink)
└── static/assets/          # client build (hashed JS)
```

`index.func/.vc-config.json` (the launcher/runtime contract):

```json
{
  "operationType": "SSR",
  "handler": "build/server/nodejs_eyJydW50aW1lIjoibm9kZWpzIn0/server-index.mjs",
  "runtime": "nodejs24.x",
  "architecture": "arm64",
  "supportsResponseStreaming": true,
  "framework": { "slug": "react-router", "version": "7.18.1" },
  "launcherType": "Nodejs",
  "useWebApi": true,
  "filePathMap": { ...see 3f... }
}
```

Note `runtime: nodejs24.x` and `architecture: arm64` — `arm64` is a local
macOS artifact (irrelevant; Vercel builds x86_64 linux). `nodejs24.x` is the
builder's **default max** (our `package.json` has no `engines.node`), *not*
derived from local Node v25 — see Phase 1 note below.

The `handler` is a builder-generated shim `server-<bundle>.mjs`
(`build/server/nodejs_<id>/server-index.mjs`) that does
`import * as build_ from './index.js'` and wraps it in
`RR.createRequestHandler`. Our addon-loading `index.js` is one hop down the
import graph from this handler — which is exactly why nft reaches the `.node`.

## 3b. How many server functions, which routes → which function

**One server bundle, one real function.** The preset's `serverBundles` hook
keys each bundle by `runtime + hash(export const config)`. None of our seven
routes declare `export const config`, so all seven inherit the default
`{ "runtime": "nodejs" }` and collapse into a single bundle
`nodejs_eyJydW50aW1lIjoibm9kZWpzIn0` (base64url of `{"runtime":"nodejs"}`).

Evidence — `.vercel/react-router-build-result.json` `routeIdToServerBundleId`
maps **all** of `routes/home, slow-io, slow-cpu, slow-cpu-rust, api.hello,
static, rust` to that one bundle id. In `.vercel/output/functions/`, only
`index.func` and `api/hello.func` are real dirs (both point their handler at
the same `server-index.mjs`); the other five `.func` entries are **symlinks to
`index.func`**. So bundle splitting is *available* but does not trigger for the
current route set — a single function serves every route.

## 3c. THE CRUX — is `native-<hash>.node` in the function that references it?

**Yes.** The build-mode chunk still renders exactly the pattern we bet on:

```js
// build/server/nodejs_<id>/index.js  (grepped from the built output)
new URL("native-69f4bbb0fd4b2a9b2f27efdcf2860e33a8b486f980188d96d048e83a22e0d528.node", import.meta.url)
```

and `index.func/.vc-config.json`'s `filePathMap` contains that file:

```
"build/server/nodejs_eyJydW50aW1lIjoibm9kZWpzIn0/native-69f4…e0d528.node":
"build/server/nodejs_eyJydW50aW1lIjoibm9kZWpzIn0/native-69f4…e0d528.node"
```

The `.node` sits at the **same directory** as `index.js`, so
`new URL("native-….node", import.meta.url)` resolves to it at runtime. nft
traced it with **zero changes to our plugin**. The physical 504 KB binary
exists at that source path (`ls` confirmed).

### Bundle-split stress test (de-risks sharp edge #2)

To prove the split case, I temporarily added
`export const config = { maxDuration: 60 };` to `app/routes/slow-cpu-rust.tsx`
and rebuilt. Result:

- Two server bundles were emitted, **each with its own copy of the addon**:
  - `build/server/nodejs_eyJydW50aW1lIjoibm9kZWpzIn0/native-69f4….node`
  - `build/server/nodejs_eyJtYXhEdXJhdGlvbiI6NjAsInJ1bnRpbWUiOiJub2RlanMifQ/native-69f4….node`
    (base64url of `{"maxDuration":60,"runtime":"nodejs"}`)
- `slow-cpu-rust.func` became a **real** function (no longer a symlink), and
  its `filePathMap` referenced the addon in the *maxDuration* bundle dir, while
  `index.func`/`rust.func` referenced the addon in the default bundle dir.

Each function independently traced the correct, same-directory `.node`. Vite
emits one addon per server bundle and nft traces each bundle's entry
independently, so **splitting is safe** — every function that imports the crate
carries its own copy at the right relative path. (Change reverted; tree clean.)

## 3d. How the preset packages files (nft, wholesale copy, or…)

Two distinct pieces, easy to conflate because they share the name:

1. **The npm preset** (`node_modules/@vercel/react-router/vite.js`, 1.3.1) does
   *not* package anything. It only (a) supplies the `serverBundles` function
   that assigns each route to a bundle by hashed config, and (b) writes
   `.vercel/react-router-build-result.json` (the build manifest) at
   `buildEnd`. No nft, no file copying here.

2. **The CLI builder** `@vercel/remix-builder` (5.7.0, bundled in the Vercel
   CLI — React Router shares Remix's builder) does the packaging. For each
   server bundle it runs nft over the generated handler and builds a
   `NodejsLambda` from **exactly the nft trace file list** — nothing else.
   Relevant source
   (`…/vercel/node_modules/@vercel/remix-builder/dist/index.js`):

   ```js
   // createRenderFunction() — the react-router/node path
   const trace = await frameworkRuntimeSettings.traceFunction({ handlerPath, rootDir, entrypointDir });
   const files = await getFilesFromTrace({ fileList: trace.fileList, rootDir });
   const fn   = frameworkRuntimeSettings.createRuntimeFunction({ files, handler, config, … });
   ```

   `traceFunction` → `traceNodeFiles` → `nodeFileTrace([handlerPath], { base: rootDir })`.
   `getFilesFromTrace` maps each traced path to a `FileFsRef`. The lambda is
   `new NodejsLambda({ files, handler, runtime, regions, memory, maxDuration, … })`.
   **The only inputs are the nft trace + the route's static config.** There is
   no "copy `build/server` wholesale" step; packaging is purely trace-driven.

## 3e. Does the preset expose `includeFiles` / a force-include escape hatch?

**No — not through this builder.** Grepping the entire remix/react-router
builder (`dist/index.js`, 4059 lines) for `includeFiles` returns **zero
matches**. The per-route/per-bundle `config` the builder consumes is only:

```js
new NodejsLambda({ …, regions: config.regions, memory: config.memory, maxDuration: config.maxDuration, … })
```

i.e. `runtime`, `memory`, `maxDuration`, `regions` — parsed from the route's
`export const config` via `@vercel/static-config`. There is **no**
`includeFiles` field, and the builder never merges `vercel.json`'s `functions`
globs into the lambda's file set. So **V3 rung 2 as written (force-include via
`includeFiles`) is NOT viable for the React Router preset** — the builder would
ignore it. This makes rung 1 holding the load-bearing result, and reframes the
real fallback ladder (see verdict).

## 3f. `.vc-config.json` `filePathMap` / asset placement

The `.func` dirs use the **`filePathMap` indirection**, not physical copies:
each `index.func/` contains *only* `.vc-config.json`. `filePathMap` maps each
logical path inside the lambda → the physical source path the deployer uploads
from. For our addon both sides are identical and repo-relative:

```
"build/server/nodejs_<id>/native-<hash>.node" : "build/server/nodejs_<id>/native-<hash>.node"
```

Because the logical path preserves the `build/server/<id>/` prefix — the same
prefix as `index.js` — the addon lands next to the chunk inside the deployed
lambda, and the `new URL(…, import.meta.url)` resolution holds at runtime. The
map also lists `server-index.mjs`, `index.js`, `package.json`, and the React /
React-Router / isbot / node-fetch-server dependency tree (~40 entries) — a
tight, correct trace. No `filePathMap` rewriting is needed from us.

---

## V3 verdict: **Rung 1 — nothing needed.**

nft recognizes the `new URL("<name>.node", import.meta.url)` our build output
already contains, traces the addon, and the preset/builder place it at the
correct relative path in **every** function that references it (single-bundle
and split-bundle both verified locally). No `includeFiles`, no codegen hint, no
post-build copy.

**Caveat — honesty bar:** this was verified with a **darwin arm64** `.node` on
macOS. The packaging *mechanism* (nft trace → filePathMap → lambda) is
platform-independent and is what Phase 0 set out to prove, so the verdict is
about tracing/placement, which will be identical on Vercel's x86_64 linux
builder. What Phase 0 cannot prove is that the *linux* binary loads and runs —
that is Phase 2/3's job (build the crate on-target, hit `/rust` and
`/slow-cpu-rust`, expect digests `4107c82d…` @700k and `09537d1e…` @6M).

### If rung 1 regressed on Vercel, the corrected fallback ladder is:

The original ladder assumed rung 2 = `includeFiles`. **That rung is dead** for
this builder (3e). The viable fallbacks, in order:

- **Rung 3 (codegen nft hint) — now the primary fallback.** Since nft is the
  sole packager, the fix space is "make the addon more visible to nft," e.g.
  keep/strengthen the statically-analyzable `new URL(x, import.meta.url)` form
  (we already emit it) or add a second blessed reference. A ~3-line change in
  `plugin/codegen.ts::buildModuleSource`. Low risk, self-contained.
- **Rung 4 (post-build copy) — harder than the plan assumed.** Because `.func`
  dirs are `filePathMap`-driven (3f), a post-build script cannot just drop the
  `.node` into a `.func` dir; it must **also patch each `.vc-config.json`'s
  `filePathMap`** to add the logical→physical entry. Brittle against builder
  changes; genuine last resort.

Given nft already traced the addon cleanly here, neither fallback is expected
to be needed.

---

## Notes for Phases 1–3

- **Node version.** `.vc-config.json` pinned `nodejs24.x`, chosen by the
  builder's default (no `engines.node` in `package.json`), independent of local
  Node v25. To pin explicitly, add `"engines": { "node": "24.x" }` to
  `package.json` before deploying. 24.x is a good default for napi/N-API.
- **`entry.server` behavior.** We have no `app/entry.server.*`, so the preset's
  `injectVercelEntryServer` only fires for **edge** routes (none of ours). For
  node routes the builder generates its own `server-<bundle>.mjs` shim — we
  never touch `react-router-serve`, so **sharp edge #6 (NODE_ENV /
  react-router-serve) is moot on Vercel**, as VERCEL-PLAN predicted.
- **Bundle id is config-derived and deterministic** (`base64url(JSON)`), so
  giving the 6M route a `maxDuration` (Phase 5) *will* split it into its own
  function — already proven to still carry the addon (3c stress test).
- **CLI-upload path is clean.** `vercel build` ran with no git remote and no
  linked project (`--yes`, offline). Phase 1 can deploy via
  `vercel deploy --prebuilt` from `.vercel/output` OR let Vercel build remotely;
  either way no GitHub repo is required. Env vars / `installCommand` (V2) would
  be set via `vercel env` / project settings or `vercel.json`
  (`installCommand`, `buildCommand`) — CLI-managed, no git needed.
- **`config.json` routing** sends unmatched non-`/api` paths to `/404.html`
  then falls through `filesystem` → SSR function; assets get immutable
  cache-control. Nothing addon-specific to tune.

## Files touched (working tree left green)

- `react-router.config.ts` — added `presets: [vercelPreset()]`.
- `package.json` / `package-lock.json` — `@vercel/react-router` dev dep.
- `.gitignore` — `.vercel/`.
- `app/routes/slow-cpu-rust.tsx` — **reverted** (split test only).
- `.vercel/output/` — present, single-bundle, gitignored.

`npx tsc --noEmit`, `npm run build`, and `vercel build --yes` all pass.
