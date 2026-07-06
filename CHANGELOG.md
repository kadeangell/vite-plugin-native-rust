# Changelog

## 0.2.0 (2026-07-06)

### vite-plugin-native-rust

- Feature ([#2](https://github.com/kadeangell/vite-plugin-native-rust/issues/2)):
  first-class **vitest** support. `rustPlugin()` now works inside a vitest config
  with zero extra options — a `.rs` import no longer parse-fails at collection.
  When it detects vitest (via `process.env.VITEST` or a resolved config carrying
  a `test` key), the plugin: **bypasses the client-graph gate** (tests run in
  Node — jsdom/happy-dom only emulate the DOM in-process — so the gate that keeps
  `.node` binaries out of the browser bundle protects nothing and would otherwise
  reject legitimate `ssr: false` test imports); **always emits the dev-shape
  loader** that requires the addon from its absolute cache path (vitest never
  writes a bundle, so the build-shape `ROLLUP_FILE_URL` token would resolve to
  nothing — and vitest reports `this.meta.watchMode === false` under *both*
  `vitest run` and `vitest --watch`, so the plugin can't lean on watch mode
  here); **compiles in debug** unless `profile: 'release'` is pinned; and **skips
  the `.d.rs.ts` write** (an editor concern that would only risk watch churn and
  cross-project races mid-test-run). Works under `vitest run`, watch mode, and
  `test.projects`.
- New public API: **`rustTestStub(mapping)`** — an `enforce: 'pre'` plugin whose
  `resolveId` redirects any import ending with a mapping key to a JS twin
  (resolved against the Vite root or an absolute path). For suites that should
  run without a Rust toolchain (CI without cargo) or that deliberately isolate
  from the native code. Exported from the package root alongside `rustPlugin`.
- New integration fixture `vitest-consumer` (vitest 4 / rolldown-vite on Vite 8)
  exercises both paths end-to-end: a jsdom project importing the crate through
  `rustPlugin()` (asserts the real Rust output) and a `test.projects` sibling
  using `rustTestStub` against a JS twin, both under `vitest run`.
- Docs: new [testing.md](docs/testing.md) covering the viral collection failure,
  both fix paths, and the `test.projects` recipe.

## 0.1.2 (2026-07-06)

### vite-plugin-native-rust

- Fix ([#1](https://github.com/kadeangell/vite-plugin-native-rust/issues/1)):
  the emitted native `.node` addon now survives `@vercel/react-router`
  `vercelPreset()` builds. When the preset splits the server into per-function
  bundles (`build/server/nodejs_*/`), a new `writeBundle` pass ensures every
  chunk that references an addon has the `.node` beside it — copying it back
  from the compile cache when a post-processing step dropped it, and **failing
  the build loudly** (naming the chunk and the missing file) when it genuinely
  can't be placed, instead of the previous silent zero-exit that shipped a
  server crashing on cold start.
- Build-mode loader is now **lazy**: function exports load the addon on first
  call via a memoized wrapper (async return values preserved), so a missing
  binary is a catchable per-call error with an actionable message (missing
  path + troubleshooting link) rather than an uncatchable module-init crash of
  the whole serverless function. Non-function exports stay eager but load
  through the same guarded loader. When every export is a function (the common
  napi case), no addon `require` runs at module top level.
- New integration fixture `react-router-v7-vercel-preset` (RR v7 on Vite 8 with
  `vercelPreset()`) reproduces the issue's per-function bundle layout and
  guards the fix end-to-end.

## 0.1.1 (2026-07-06)

### vite-plugin-native-rust

- Docs only: the packaged README now states that Windows support is not
  planned (0.1.0 shipped the older "not yet supported" wording). No code
  changes.

## 0.1.0 (2026-07-03)

Initial public release. Experimental — the API may change before 0.2.

### vite-plugin-native-rust

- Import Rust crates directly from Vite SSR server code
  (`import { fn } from "./crate/src/lib.rs"`): compiles the enclosing
  napi-rs crate to a native `.node` addon, generates typed named exports,
  and loads the binary at runtime off the Node event loop.
- Content-hash compile cache covering the crate's **full local dependency
  closure** (path deps, workspace members, workspace manifest, lockfile —
  via `cargo metadata`) plus the `rustc` and `@napi-rs/cli` versions.
- Server-only enforcement: importing `.rs` from client-reachable code is a
  build error.
- TypeScript support: mirrors napi's generated `.d.ts` to `<file>.d.rs.ts`
  (`allowArbitraryExtensions`).
- Build-mode asset emission that survives bundlers and serverless file
  tracing (verified on Vercel with zero config changes); sets
  `build.ssrEmitAssets` so bare `vite build --ssr` ships the addon.
- Options: `cacheDir`, `profile`, `napiArgs`, `generateCratePackageJson`,
  `emitTypes`, `logLevel`.
- Atomic cache writes; cross-process safe.
- Supported: Vite >= 6 (tested through the Vite 8 Environment API via
  React Router v8), React Router v7/v8, vanilla Vite SSR, macOS/Linux,
  Node >= 20. Windows support is not planned.

### create-native-rust

- `npm create native-rust <dir>` scaffolds a ready-to-build napi-rs crate
  (cdylib, napi v3, required `napi.binaryName` package.json, async + sync
  sample exports) and prints the wiring steps.
