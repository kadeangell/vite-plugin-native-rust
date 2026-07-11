# Changelog

## 0.3.5 (2026-07-10)

### vite-plugin-native-rust

- fd-exhaustion self-diagnosis ([#6](https://github.com/kadeangell/vite-plugin-native-rust/issues/6)):
  when a cargo spawn fails or recovers on retry, the plugin now reads its own
  process's open-fd count (`/dev/fd`) and, when it's pathological
  (≥ `FD_PRESSURE_THRESHOLD` = 8192 — well above a healthy dev server's ≈3.4k
  yet far below the ≈24k where macOS/Node spawning breaks entirely), names
  fd-table exhaustion as the cause in the message instead of blaming a
  transient flake. Covers the `cargo --version` preflight, the recovered-retry
  log line, and the `cargo metadata` / `generate-lockfile` fallback warnings.
  Below the threshold (or on a platform without `/dev/fd`) the wording is
  unchanged. The troubleshooting doc now reframes `lsof` as *confirming the
  holder* rather than initial diagnosis.

## 0.3.4 (2026-07-10)

### vite-plugin-native-rust

- Issue #6 root cause found and mitigated: `spawn EBADF` was **file-descriptor
  exhaustion** — a dev-server process holding ~24k+ fds (proven by clean-room
  reproduction) breaks all child-process spawning on macOS/Node. Watchers
  without fsevents (chokidar 4 = kqueue) hold an fd per watched file, so huge
  trees inside the watched root (vendored envs, datasets, cargo `target/`)
  poison the process. The plugin now watch-ignores every known crate's
  `target/` in Vite's watcher (config-time via the pre-warm manifest +
  `prewarm` anchors; runtime unwatch for crates discovered at first load).
  Framework-owned watchers (e.g. `@react-router/dev`'s hardcoded appDirectory
  watcher) are out of the plugin's reach — see the new troubleshooting entry.

## 0.3.3 (2026-07-08)

### vite-plugin-native-rust

- Recovered transient-spawn retries are now logged
  (`[vite-rust] transient spawn error (EBADF) on \`cargo\` recovered on
  retry…`) so field reports can distinguish a first-spawn-only poisoned fd
  table from a one-off flake (issue #6 follow-up). A boundary search
  established the EBADF class is not reachable via shell piping / closed
  stdio / fd churn / ulimits on a healthy Node — the working theory is a
  native dependency in the host process double-closing file descriptors.

## 0.3.2 (2026-07-08)

### vite-plugin-native-rust

- Fix ([#7](https://github.com/kadeangell/vite-plugin-native-rust/issues/7)):
  `.rs` imports resolve correctly when rolldown-vite (Vite 8) passes
  project-root-relative importer ids ("/app/…" instead of real filesystem
  paths). The resolved path is re-anchored under `config.root` when it isn't
  on disk but the root-anchored form is — previously the crate walk climbed
  the real filesystem from a directory that doesn't exist and failed with
  "No Cargo.toml found" even though the crate compiled.

## 0.3.1 (2026-07-07)

### vite-plugin-native-rust

- Fix ([#6](https://github.com/kadeangell/vite-plugin-native-rust/issues/6)):
  transient spawn failures are no longer misreported as a missing toolchain.
  The cargo preflight only claims "`cargo` was not found on your PATH" on a
  real ENOENT; other spawn-level errors (e.g. the documented macOS/Node
  `spawn EBADF` flake) surface their actual code with a "transient — retry"
  hint. The preflight, `cargo metadata`, and `cargo generate-lockfile` calls
  all retry once on EBADF/EAGAIN — command exit codes are never retried.

## 0.3.0 (2026-07-07)

Addresses all three open roadmap issues (#3, #4, #5).

### vite-plugin-native-rust

- Feature ([#3](https://github.com/kadeangell/vite-plugin-native-rust/issues/3)):
  new **`vite-plugin-native-rust/nitro`** subpath for Nitro-family frameworks
  (Nuxt `server/` routes, SolidStart v1/vinxi, raw Nitro): `nitroRustPlugin()`
  (server-context forcing under raw Rollup + repair of the
  `import.meta.ROLLUP_FILE_URL_*` tokens Nitro's replace shim mangles +
  neutralized chunk-sibling recovery), `nitroShipAddons()` (additive Nitro
  module placing the upstream Vite pass's `.node` on the `compiled` hook —
  never `hooks.compiled`, which would replace preset hooks), and
  `nitroPreserveImportMeta()`. Built and verified against **Nitro 2.x**; Nitro
  v3 is a rewrite — issue #3 stays open to revalidate there. The nuxt and
  solidstart examples now use the helpers (-146 lines of hand-rolled adapter).
  Full rationale in [docs/nitro.md](docs/nitro.md).
- Feature ([#5](https://github.com/kadeangell/vite-plugin-native-rust/issues/5)):
  **dev-server pre-warm**. At `configureServer` the plugin starts compiling
  every crate it can discover, so a cold cargo build races your first request
  instead of blocking inside it (and timing out Nitro-style 60s module-runner
  fetches, which cache the failure until restart). Discovery: a
  `prewarm-manifest.json` in `cacheDir` remembers previously compiled crates
  (zero config), plus a new `prewarm: boolean | string[]` option for explicit
  anchors / disabling. Requests arriving mid-pre-warm coalesce onto the
  in-flight compile (`load` and pre-warm share one `ensureCrateCompiled`
  pipeline); pre-warm failure is a warning, never a dead server.

- Fix ([#4](https://github.com/kadeangell/vite-plugin-native-rust/issues/4)):
  stable cache key for crates that don't have a `Cargo.lock` yet. The plugin
  now runs `cargo generate-lockfile` (metadata-only, no compile) before the
  first hash when no lockfile exists at or above the crate dir, so the lockfile
  is part of the key — and of the watch set — from the very first build instead
  of appearing mid-session after the first compile and shifting the key.
  Previously a multi-pipeline build (e.g. Nuxt's Vite + Nitro passes on a cold
  Vercel builder) recompiled an identical crate (~24s wasted). Notably, the
  `cargo metadata` closure resolution already wrote the lockfile as a side
  effect on its success path; the explicit generation makes the ordering
  deterministic and — crucially — also covers the metadata-failure fallback
  (single-crate hashing), which never created one. If `generate-lockfile`
  fails, the plugin warns once per crate and proceeds with the old behavior.

### create-native-rust

- Scaffolded crates now ship a `Cargo.lock` from birth: the CLI runs
  `cargo generate-lockfile` at scaffold time when cargo is available, and
  prints a note (never fails the scaffold) when it isn't. The next-steps
  output now also reminds you to commit the lockfile.

## 0.2.1 (2026-07-07)

### vite-plugin-native-rust

- Fix: the `writeBundle` addon guarantee now resolves the path each chunk
  actually references (`new URL("../…​.node", import.meta.url)`) instead of
  assuming the addon is a sibling. Under Vite 8 / rolldown layouts (Astro,
  SvelteKit) the old assumption fired a false "recovered dropped addon"
  warning and wrote a redundant copy on every build; recovery copies now
  also land at the genuinely referenced path.

### examples

- Eight new examples, all deployed + validated on Vercel: `sveltekit`,
  `astro`, `tanstack-start`, `qwik` (plugin works out of the box; first
  Vite 8/rolldown validation; Qwik deploys via Node middleware since its
  official Vercel adapter is edge-only), `nuxt` and `solidstart` (working,
  each with a documented Nitro recipe — see issue #3 for the planned
  first-class helper), `nextjs` and `remix-v3` (no Vite in those
  frameworks — same napi-rs crate consumed directly, with the required
  file-tracing/bundler workarounds documented).

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
