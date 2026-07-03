# How it works

This plugin turns `import { fn } from "./native/src/lib.rs"` into a working
native addon call. Here is the whole pipeline, in the order it runs, and why each
step is shaped the way it is. You do not need to know any of this to use the
plugin — read it when something surprises you, or before filing a bug.

The plugin runs with `enforce: "pre"`, so it claims `.rs` specifiers before Vite
core or your framework plugin touch them.

## 1. `resolveId` — claim the specifier, decide nothing

`resolveId` intercepts a source only when it ends in `.rs` **and** is a relative
(`./`, `../`) or absolute path. A bare `some-pkg/foo.rs` is left alone — that
belongs to a package, not to you. The matched path is resolved against the
importing file and returned with a `?rust` marker so `load` can recognize it.

`resolveId` deliberately makes **no** server-vs-client decision. During a client
build, Vite may call `resolveId` for the same module more than once, and at least
one of those calls reports `options.ssr === true` even for a client-graph module.
Gating here would be unreliable, so the gate lives in `load` instead.

## 2. `load` — the server gate

The first thing `load` does is check `options.ssr`. If it is falsy, the module is
reaching the **client** graph, and the plugin fails with a readable error:

> Rust modules can only be imported server-side — import this only from a
> `.server.ts` module (or another server-only module), never from code that can
> reach the client bundle.

This gate is **load-bearing, not defense-in-depth**. A `.server.ts` importer
never reaches the client build at all (your framework strips server-only modules
from the client graph), so in normal use this error never fires. It fires exactly
when a plain `.rs` import would otherwise leak a native binary toward the browser —
and there, `options.ssr` is reliably `false`, so the plugin can stop it. Unlike
`resolveId`, `load` reports `options.ssr` correctly in every context (verified in
dev SSR, the client build pass, and the SSR build pass).

## 3. Find the enclosing crate

Cargo compiles **crates, not files**. The imported `.rs` path is a *crate
anchor*: the plugin walks up from it to the nearest `Cargo.toml`. Importing any
`.rs` file inside a crate yields that whole crate's exports. If no `Cargo.toml`
is found before the filesystem root, you get an error naming the file and where
the search started.

Convention: one crate per native unit, imported via its `src/lib.rs`.

## 4. The dependency closure (why a sibling-crate edit recompiles)

Before hashing anything, the plugin runs `cargo metadata` for the crate and
derives its full **local** footprint: every path dependency and workspace-member
crate's sources, the workspace-level `Cargo.toml`, and the `Cargo.lock`.
Registry and git dependencies are excluded — their versions are already pinned by
the lockfile, which *is* in the set.

Every file in that closure is folded into two things:

1. the **`addWatchFile`** set, so editing a sibling path-dep crate triggers a dev
   reload; and
2. the **cache hash** (next step), so the same edit forces a recompile instead of
   serving a stale binary.

`cargo metadata` costs roughly 100–300 ms, so the resolved layout is memoized per
crate directory and guarded by manifest mtimes — a dependency-graph change (which
always edits a `Cargo.toml`) re-runs it; source-only edits reuse it. If
`cargo metadata` ever fails, the plugin warns and falls back to hashing just the
single crate, so a metadata hiccup never hard-fails your dev server.

## 5. Cache key and compile

The cache key is a content hash of every closure file **plus** a toolchain
fingerprint: `rustc -V` and the resolved `@napi-rs/cli` version. A toolchain
upgrade can change the addon's ABI or codegen even when your source is
byte-identical, so it must invalidate the cache.

The output filename is `<binaryName>-<hash>-<profile>.node` in the cache dir
(`node_modules/.cache/vite-rust` by default). If that file already exists, the
compile is skipped entirely — that is the cache hit that makes warm builds
instant. Otherwise the plugin runs `napi build` (debug) or `napi build --release`
(prod). Two `.rs` imports from the same crate are de-duplicated by an in-flight
promise so they never race two cargo processes, and the built binary is copied
into the cache via a temp-file-plus-atomic-rename so two concurrent Vite
processes can't observe a partial file.

The profile is auto-selected: `debug` in dev/watch mode (fast compile), `release`
for `vite build` (slower compile, dramatically faster runtime). You can force it
with the `profile` option.

napi v3 refuses to build without a `package.json` carrying `napi.binaryName` in
the crate directory; the plugin creates or augments one for you unless you set
`generateCratePackageJson: false`.

## 6. Named-export enumeration

napi generates one addon with whatever functions you annotated `#[napi]`. To
produce **named** ESM exports (so `import { hashChain }` works), the plugin
`require()`s the freshly built `.node` **in its own process** — same platform,
ground truth — and enumerates `Object.keys(addon)`, keeping only valid JS
identifiers. napi lowercases `snake_case` to `camelCase`, so a Rust `hash_chain`
is enumerated as `hashChain`, matching the generated `.d.ts`.

## 7. The generated JavaScript — dev vs. build

The module the plugin emits differs between dev and build, because the addon
lives in a different place in each.

**Dev** (watch mode) requires the addon straight from its absolute cache path:

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const addon = require("/abs/path/node_modules/.cache/vite-rust/native-<hash>-debug.node");
export const hashChain = addon.hashChain;
export const add = addon.add;
```

**Build** cannot inline an absolute path — the binary must travel with the output
and resolve wherever it lands. So in build mode the plugin `emitFile`s the `.node`
as an asset and references it through Rollup's file-URL token:

```js
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const addon = require(fileURLToPath(import.meta.ROLLUP_FILE_URL_<ref>));
export const hashChain = addon.hashChain;
```

Rollup rewrites `import.meta.ROLLUP_FILE_URL_<ref>` into
`new URL("native-<hash>.node", import.meta.url).href` — a **relative** URL
resolved against whichever server chunk the code lands in. No knowledge of your
`outDir` or deploy layout is needed, and if bundle splitting puts the import in
two chunks, each chunk gets its own correctly-placed copy of the addon.

### Why the binary isn't bundled

What keeps the `.node` out of the bundle is that Vite/Rollup do not trace
functions created by `createRequire` — the `require` argument stays opaque to the
bundler. This holds **unless** you add a CommonJS-transform plugin to your Vite
config; don't, or it may try to follow the require and break.

## 8. Why bundlers and `@vercel/nft` still trace the addon

The build-mode form is deliberately `new URL("<name>.node", import.meta.url)` —
the exact statically-analyzable pattern that `@vercel/nft` (the file tracer
serverless builders use) recognizes. On Vercel's React Router preset, nft traces
that reference from the server chunk and places the addon at the same relative
path inside the deployed function, with **zero** plugin or config changes. That
is why `vite build` output — and a serverless deploy of it — just works. See
[deployment-vercel.md](deployment-vercel.md) for the details.

## 9. TypeScript types

After a successful compile, the plugin copies napi's generated `index.d.ts` to a
`<anchor>.d.rs.ts` file beside your imported `.rs` (unless `emitTypes: false`).
With `allowArbitraryExtensions` enabled, TypeScript resolves the types for
`./lib.rs` from the sibling `lib.d.rs.ts`. Commit that file so CI type-checks
without a Rust toolchain — see [typescript.md](typescript.md).

## The parallelism contract

The runtime win depends on **how you write the Rust**, not on the plugin:

- `#[napi] async fn` runs on napi-rs's Tokio worker pool (sized to your CPU
  cores), returning a real JS Promise. The Node event loop never blocks. This is
  the shape to use for anything heavy.
- A synchronous `#[napi] fn` runs on the Node main thread — heavy work there
  blocks the event loop exactly like the JavaScript it replaced. Reserve sync
  exports for trivial, non-blocking calls.

Use rayon *inside* an async fn for data parallelism. The event-loop-freedom
result in [benchmarks.md](benchmarks.md) is entirely a consequence of the
`async fn` form.
