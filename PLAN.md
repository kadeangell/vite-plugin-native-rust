# Vite plugin: import Rust directly from `.server.ts`

> **Status: IMPLEMENTED (2026-07-02).** All build-order steps 0–8 are done.
> The plugin lives in `plugin/`, the demo crate in `native/`, verified spike
> evidence in `SPIKE-FINDINGS.md`, and production A/B numbers in
> `MEASUREMENTS.md` (headline: ~2.9× single-request, ~10.7× at 5-way
> concurrency, event loop stays at 1–2ms under load vs fully starved).
> One correction to this plan discovered by measurement: `#[napi] async fn`
> runs on napi-rs's Tokio pool (sized to CPU cores), not the libuv pool —
> `UV_THREADPOOL_SIZE` is irrelevant for the `async fn` form.
>
> **Next scope expansion:** Vercel deployment — see `VERCEL-PLAN.md`.

## Goal

A custom Vite plugin (used alongside, **not** modifying, `@react-router/dev/vite`)
that lets us write:

```ts
// something.server.ts
import { doTheThing } from "./native/src/lib.rs";
```

The plugin compiles the enclosing Rust crate into a native `.node` addon for the
current platform and wires it up so Node loads it at runtime. Target framework
is React Router v7 (Vite-based), with v8 as a secondary target — nothing below
depends on RR internals beyond "server-only modules never reach the client
graph", so the v8 story should be free.

## Motivation

Reduce time spent in server functions via **true parallelism**: heavy compute
moves into Rust, runs on real threads off the Node event loop, and the loader
just awaits a Promise. Accepted risk: we may build this and find our
bottlenecks were I/O all along. Building anyway.

## Rejected alternatives (decided, don't relitigate)

- **WASM (wasm-pack + vite-plugin-wasm).** Would erase both sharp edges below
  (no dlopen, platform-independent), but WASM threads in Node require
  SharedArrayBuffer + worker gymnastics and wasm-bindgen-rayon is
  browser-oriented. Parallelism is the whole point → native.
- **worker_threads / Piscina.** Real parallelism, zero toolchain, but JS-speed
  cores. Rejected on per-core throughput; Rust is typically 10–50x on real
  compute before rayon even enters.
- **cdylib + FFI (koffi).** No napi dependency, but we hand-write FFI
  signatures and own type/memory discipline at the boundary — wrong tradeoff
  given limited Rust familiarity.

---

## Locked decisions

### D1 — napi-rs (was Decision 1)

Drive builds with `@napi-rs/cli` (`napi build`). Gives us: `#[napi]` macros,
the N-API glue, correct platform handling, and **generated `.d.ts`** (feeds the
TypeScript story below). Dev compiles use the debug profile (fast), `vite
build` uses `--release`.

Parallelism contract this enables: a `#[napi]` async fn (or `AsyncTask`) runs
on a thread pool and returns a real JS Promise — event loop never blocks.

### D2 — hashed-filename recompile (was Decision 2)

The compile cache and dev reload are **the same mechanism**: hash the crate
sources → cache key → the output is named `<crate>-<hash>.node`. On edit, new
hash → new filename → fresh `dlopen`. Old handles leak; dev-only, bounded by
edit count, accepted. (See Sharp Edge 1 — this is its resolution.)

### D3 — `emitFile` into the server build (was Decision 3)

In build mode, `this.emitFile({ type: 'asset', ... })` the `.node` into the
server output and reference it via Rollup's file-URL mechanism so the require
path is correct **per-chunk** regardless of output layout:

```js
require(fileURLToPath(import.meta.ROLLUP_FILE_URL_<ref>))
```

Rollup rewrites that to a relative URL from whichever chunk the code lands in.
No knowledge of outDir or deploy layout needed. Verify rendering in the spike
(step 0); fallback if it misbehaves under RR's SSR build: fixed `fileName` at
output root + `require("./<name>.node")`, which works while the server build is
a single flat chunk.

### D4 — client gate via `options.ssr` (was Open Question A)

Don't touch environment names at all. Both `resolveId(source, importer,
options)` and `load(id, options)` receive `options.ssr` — stable across Vite
5/6/7, works with and without RR's environment-API flag:

```ts
if (!options?.ssr) this.error("Rust modules can only be imported server-side");
```

This gate is load-bearing, not defense-in-depth: a plain (non-`.server.ts`)
module importing `.rs` *would* reach the client graph; this is what stops it
with a readable error.

---

## Architecture

### Plugin shape

Single plugin, `enforce: 'pre'` so we claim `.rs` specifiers before RR/Vite
core touch them.

- **`resolveId`** — claim specifiers that end in `.rs` AND start with `./`,
  `../`, or are absolute (never intercept bare `some-pkg/foo.rs`). Resolve
  against the importer (query-stripped), return absolute path + `?rust` marker.
- **`load`** — the core:
  1. gate on `options.ssr` (D4),
  2. walk up from the `.rs` file to the enclosing `Cargo.toml` (error clearly
     if none found before filesystem root),
  3. compile the crate via napi CLI (D1) with content-hash caching (D2),
  4. `addWatchFile` every hashed input (all `src/**/*.rs`, `Cargo.toml`,
     `Cargo.lock` if present),
  5. in build mode, `emitFile` the binary (D3),
  6. return generated JS.

### Generated JS (named exports only)

The goal snippet uses named imports, so the shim must produce named exports.
After a successful compile, `require()` the fresh `.node` **in the plugin
process** (same platform, ground truth) and enumerate `Object.keys(addon)`:

```js
// dev
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const addon = require("/abs/path/node_modules/.cache/vite-rust/thing-abc123.node");
export const doTheThing = addon.doTheThing;
export const alsoExported = addon.alsoExported;
```

```js
// build — path comes from ROLLUP_FILE_URL per D3
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const addon = require(fileURLToPath(import.meta.ROLLUP_FILE_URL_<ref>));
export const doTheThing = addon.doTheThing;
```

No default export — one export shape, and it matches napi's generated `.d.ts`.
Skip keys that aren't valid JS identifiers.

Note for accuracy: the require argument is a *static* string literal — what
shields the binary from bundling is that Vite/Rollup don't trace
`createRequire`-created functions, not "dynamic require". Holds unless a
commonjs-transform plugin enters the config; don't add one.

### Compile & cache

- Cache dir: `node_modules/.cache/vite-rust/`.
- Cache key: hash of `Cargo.toml` + `Cargo.lock` (if present) + all
  `src/**/*.rs` contents, paths sorted. Key hit → skip compile entirely.
- Output: `<crateName>-<hash>.node` (D2 makes this double as dev reload).
- Dedupe concurrent compiles with an in-flight promise map keyed by crate dir
  (two `.rs` imports from one crate must not race two cargo processes).
- First compile is slow (cargo cold start, ~30s+). Log progress so dev-server
  startup doesn't look hung.

### Errors (all fail fast, all actionable)

- No `cargo` on PATH → "install Rust: https://rustup.rs".
- No `@napi-rs/cli` → "pnpm add -D @napi-rs/cli".
- No `Cargo.toml` above the imported `.rs` → say which file, where we looked.
- Compile failure → `this.error` with the stderr tail (cargo errors are good;
  don't bury them).

---

## Rust side

### Crate layout (colocation expectation)

Cargo compiles **crates, not files**. The imported `.rs` path is a *crate
anchor* — importing any `.rs` inside the crate yields the whole crate's
exports. Convention: one crate per native unit, imported via its `src/lib.rs`:

```
app/
  routes/
    reports.server.ts        →  import { crunch } from "../native/src/lib.rs"
  native/
    Cargo.toml               (crate-type = ["cdylib"], napi + napi-derive deps)
    src/lib.rs
```

True per-file colocated Rust would need nightly `cargo -Zscript` — out of
scope. If multiple crates appear, put them in one cargo workspace at repo root
to share the `target/` dir.

### Async-by-convention (the parallelism contract)

Every exported function doing nontrivial work is `#[napi] async fn` (or
`AsyncTask`) — sync `#[napi]` fns are for trivial getters only. A sync export
doing heavy work blocks the Node main thread exactly like the JS it replaced.
Use rayon *inside* the async fn for data parallelism.

```rust
#[napi]
pub async fn crunch(input: Buffer) -> Result<Buffer> {
    // runs off the event loop; rayon::par_iter inside as needed
}
```

---

## TypeScript

Without help, tsc rejects `import ... from "./lib.rs"`.

- tsconfig: `"allowArbitraryExtensions": true` (TS ≥ 5.0). TS then resolves
  types for `./lib.rs` from a sibling `lib.d.rs.ts`.
- napi already emits a `.d.ts` during build; after each successful compile the
  plugin copies it to `<anchor>.d.rs.ts` next to the imported file.
- **Commit the generated `.d.rs.ts`** so CI typechecking works without a Rust
  toolchain.

Fallback if `allowArbitraryExtensions` fights something: `declare module
"*.rs"` — everything becomes `any`; avoid unless forced.

---

## Known runtime sharp edges

### Sharp Edge 1 — native hot reload in dev

A `dlopen`'d lib can't be cleanly unloaded; re-requiring the same path returns
the stale handle. **Resolved by D2**: content-hashed filenames mean edits load
a fresh path. The old copies leak in the dev-server process — inherent to
native modules, dev-only, accepted.

### Sharp Edge 2 — prod asset placement

The absolute cache path inlined in dev won't exist on the deploy target.
**Resolved by D3**: `emitFile` + `ROLLUP_FILE_URL` makes the artifact travel
with the server build and resolve relatively. Acceptance test: `vite build`,
then move/rename the build dir, then `node <moved>/server/index.js` — must
still load.

---

## Build order

0. **Spike (no plugin — kills all the real risk first).** Scaffold a napi
   crate by hand (`napi new`), build it, paste the `createRequire(<abs path>)`
   shim into a real `.server.ts` loader. Verify: (a) RR dev SSR runs it, (b) an
   async `#[napi]` fn keeps the event loop responsive under load, (c) in a
   throwaway `vite build`, `emitFile` + `ROLLUP_FILE_URL` renders a working
   relative require in the server bundle, (d) `options.ssr` is populated in
   `load` as expected, (e) napi's `.d.ts` output looks usable for step 7.
1. Plugin skeleton: `resolveId` marker + `load` with a hardcoded compile of the
   spike crate; dev end-to-end.
2. `findCargoToml`, source hashing, cache, hashed `.node` names (dev reload
   falls out of this).
3. Named-export generation (require addon in-process, enumerate keys).
4. `addWatchFile` for all hashed inputs; in-flight compile dedupe.
5. `options.ssr` gate + the actionable error set.
6. Build mode: `--release`, `emitFile`, file-URL reference; run the Sharp
   Edge 2 acceptance test (moved build dir).
7. TypeScript: `allowArbitraryExtensions` + emit `<anchor>.d.rs.ts`.
8. E2E in the real app: port one genuinely heavy server function, measure
   before/after under concurrent load — this is the payoff the whole project
   is betting on.

---

## Explicitly out of scope (for now)

- Cross-compilation / multi-platform prebuilds (build on target platform).
- Per-file crates (`cargo -Zscript` is nightly-only).
- Non-`.server.ts` import sites beyond the `options.ssr` hard error.
- Windows `.node` path quirks (revisit if Windows becomes a deploy target).
