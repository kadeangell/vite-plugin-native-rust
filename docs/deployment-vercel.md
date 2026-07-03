# Deploying to Vercel

The plugin's `vite build` output carries the compiled addon with it, and Vercel's
React Router preset traces and packages that addon automatically. Deploying a Rust
route to Vercel Functions needs **no plugin or codegen changes** — only a Rust
toolchain during the build and a couple of config files. This is a verified,
end-to-end-tested path (the example app is deployed this way, serving the Rust
routes from an x86_64 linux function).

The one real cost is that the crate is compiled **on-target during the build**:
Vercel's build image ships `rustup` but with no default toolchain configured, so
your build scripts have to install one. Everything below is about doing that
efficiently.

## 1. The preset

Add `@vercel/react-router` and enable its preset in your React Router config:

```bash
npm i -D @vercel/react-router
```

```ts
// react-router.config.ts
import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

export default {
  ssr: true,
  presets: [vercelPreset()],
} satisfies Config;
```

The preset is non-breaking — plain `npm run build` still works. Its only visible
effect is that the server bundle lands in a per-config subdirectory
(`build/server/nodejs_<hash>/`) instead of `build/server/`. The addon is emitted
into that same subdirectory, so the build-mode `new URL("native-<hash>.node",
import.meta.url)` still resolves next to the server chunk.

## 2. Pin the Node runtime

Add an explicit `engines.node` so the function runtime is stable (napi/N-API is
happy on 24.x):

```json
// package.json
"engines": { "node": "24.x" }
```

## 3. The build scripts

Vercel rejects an `installCommand` longer than 256 characters, so the toolchain
logic goes in scripts:

```json
// vercel.json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "installCommand": "bash scripts/vercel-install.sh",
  "buildCommand": "bash scripts/vercel-build.sh"
}
```

**`scripts/vercel-install.sh`** — install deps, then ensure a toolchain:

```bash
#!/usr/bin/env bash
set -euo pipefail                # fail the build on any toolchain error
npm install

export CARGO_HOME="$PWD/node_modules/.cache/cargo"     # cache dir Vercel persists
export RUSTUP_HOME="$PWD/node_modules/.cache/rustup"    # toolchain lands here → cached

# The image ships rustup at /rust/bin; the curl branch only fires if it is absent.
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --no-modify-path --default-toolchain none
fi

export PATH="$CARGO_HOME/bin:$PATH"
rustup set profile minimal       # no docs/clippy/rustfmt → smaller cache
rustup toolchain install stable  # downloads once (cold), no-op when cached
rustup default stable            # fixes the image's "no default toolchain" error
cargo --version                  # prove the toolchain is usable
```

**`scripts/vercel-build.sh`** — put cargo on `PATH` and build:

```bash
#!/usr/bin/env bash
set -euo pipefail
export CARGO_HOME="$PWD/node_modules/.cache/cargo"
export RUSTUP_HOME="$PWD/node_modules/.cache/rustup"        # same as install → finds stable
export CARGO_TARGET_DIR="$PWD/node_modules/.cache/cargo-target"  # cache compiled crate deps
export PATH="$CARGO_HOME/bin:$PATH"
cargo --version                  # fail fast if PATH/toolchain is wrong
npm run build                    # → Vite plugin → napi build --release
```

The env from `installCommand` does **not** persist into `buildCommand` (separate
shells), so the build script re-exports `PATH`/`CARGO_HOME`/`RUSTUP_HOME`. This
matters because the plugin shells out to `napi build --release`, and *that*
process needs `cargo` on `PATH`.

## 4. Cache strategy — everything under `node_modules/.cache`

Vercel persists `node_modules/.cache` in its build cache, so pointing all the
Rust state there makes it ride along on warm builds:

- `CARGO_HOME` — cargo registry + downloaded crates
- `RUSTUP_HOME` — the installed toolchain
- `CARGO_TARGET_DIR` — compiled crate dependencies
- the plugin's own `.node` cache lives at `node_modules/.cache/vite-rust`
  already

On a warm build (cache restored, crate source unchanged), the plugin's
content-hash cache hits and **`napi build` is never invoked** — the SSR bundle
builds in ~100 ms instead of ~24 s, and the toolchain download is skipped
entirely.

**Warm-cache caveat:** Vercel's build cache is per-target/per-lineage. A preview
build does not warm a production build, and the *first* build on a new target
pays the full cold cost (toolchain download + crate compile, ~40 s total in the
measured deploy). Warm reuse is real but only within the same target's chain.

## 5. What `@vercel/nft` traces automatically

Serverless builders package a function from exactly the file list that
`@vercel/nft` traces from the handler — nothing else. Because the build-mode
output contains `new URL("native-<hash>.node", import.meta.url)`, nft recognizes
the addon reference, traces it, and the builder places the `.node` at the same
relative path inside the deployed function (via the `.vc-config.json`
`filePathMap` indirection). This was verified for both the single-bundle case and
the bundle-split case (a route with `export const config = { maxDuration }` gets
its own function, each carrying its own correctly-hashed copy of the addon).

There is **no** `includeFiles` escape hatch in this builder, and none is needed —
the trace is what does the work, and it holds on its own.

## 6. Monorepo / root directory notes

If your app is a package inside a workspace (like this repo's
`examples/react-router`), set the Vercel project's **Root Directory** to the app
package and enable **"Include files outside the Root Directory"** so the whole
workspace is present at build time. The scripts then resolve the repo root
relative to their own location and run `npm install` / `npm run build` from
there, so the app resolves the workspace-local `vite-plugin-native-rust`. See
`examples/react-router/scripts/vercel-install.sh` and `vercel-build.sh` for the
exact monorepo variant.

## 7. Serverless expectations (be realistic)

On Vercel the runtime win is **latency and cost**, not availability. Full numbers
and the fan-out reasoning are in [benchmarks.md](benchmarks.md#vercel-serverless);
the short version:

- **~7× faster** per request for a CPU-bound workload (measured 18.3 s JS vs
  2.6 s Rust for a 6M-iteration hash chain), and the gap *grows* on a slower
  serverless vCPU — the weaker the CPU, the bigger Rust's win here.
- **~7× lower active-CPU billing**, because Fluid bills active CPU time and a JS
  request holds its instance ~7× longer.
- **Availability is not a differentiator here.** Fluid fans concurrent requests
  out to separate instances, so a blocking JS request never starves an unrelated
  one — the "one slow loader takes down the box" problem you'd see locally does
  **not** happen on Vercel. Rust's advantage is per-request speed and everything
  downstream of it, not event-loop freedom.
- **Cold start** adds only ~0.35–0.38 s with the ~500 KB addon loaded — a native
  `dlopen` on function init is cheap.

## Verifying a deploy

```bash
curl -s https://<your-app>.vercel.app/rust | grep -o '4107c82d[0-9a-f]*'
curl -s https://<your-app>.vercel.app/slow-cpu-rust | grep -o '09537d1e[0-9a-f]*'
```

Both Rust routes should return the known-good digests (`4107c82d…` at 700k
iterations, `09537d1e…` at 6M) — identical to the local values, which is how you
know the on-target linux binary computed the same thing.
