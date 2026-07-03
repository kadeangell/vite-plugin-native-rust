# Vercel deploy — Phases 1–3 execution record

Deploying the RRv7 app (including routes that `import { hashChain } from
"../native/src/lib.rs"`) to Vercel Functions, with the native addon compiled
on-target during `vercel build` and packaged by `@vercel/nft`.

**Result: it works, rung 1 held, zero plugin/codegen changes.** The Rust
routes return the exact expected digests from the deployed x86_64 linux
function. The only new files are `vercel.json` + two build scripts and an
`engines` pin — the plugin, crate, and app source are untouched.

## Project / URLs

| | |
|---|---|
| Project | `vite-rust-import-plugin` (scope `kade-2476s-projects`, `team_Mro3g2liWcJ65sqfAeY4Ld30`) |
| Production alias | https://vite-rust-import-plugin.vercel.app |
| Current prod deployment | https://vite-rust-import-plugin-zrf57b172-kade-2476s-projects.vercel.app |
| Current prod inspect | https://vercel.com/kade-2476s-projects/vite-rust-import-plugin/mYKxBQJtpjqyiRaNAqTRSuo2jByS |
| CLI / account | Vercel CLI 50.33.0 (local) → build ran CLI 54.18.7; authenticated `kade-2476` |
| Deploy method | CLI upload (`vercel deploy` from the directory) — no git repo |

The build runs in `iad1` (Washington DC), build machine "2 cores, 8 GB",
image ships **rustup at `/rust/bin`** and Node 24.x (from the `engines` pin).

## Files changed for the deploy

Pre-existing from Phase 0 recon (already in tree): `react-router.config.ts`
`presets: [vercelPreset()]`, `@vercel/react-router` dev dep, `.vercel/` in
`.gitignore`. Added in Phases 1–3:

- **`package.json`** — added `"engines": { "node": "24.x" }`. Pins the function
  runtime; without it the builder defaults to its max (was `nodejs24.x` anyway,
  but the pin makes it explicit and stable). N-API/napi-rs is happy on 24.x.
- **`vercel.json`** — install/build command overrides (below).
- **`scripts/vercel-install.sh`**, **`scripts/vercel-build.sh`** — the actual
  toolchain logic. Lives in scripts because Vercel rejects an `installCommand`
  longer than 256 characters (hit that on the first attempt).

Nothing in `plugin/`, `native/`, or the app changed. `app/routes.ts` was
temporarily edited in Phase 1 (JS-only baseline) and fully restored in Phase 2.

### `vercel.json` (final)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "installCommand": "bash scripts/vercel-install.sh",
  "buildCommand": "bash scripts/vercel-build.sh"
}
```

- `installCommand` → `scripts/vercel-install.sh`: `npm install`, then ensure a
  Rust toolchain. Rationale: the build image has rustup but **no default
  toolchain**, so plain `cargo` fails; the script sets a minimal stable
  toolchain into a cached dir.
- `buildCommand` → `scripts/vercel-build.sh`: put cargo on `PATH` and run
  `npm run build`. Rationale: the Vite plugin shells out to `napi build
  --release` (cwd = crate), and **that** process needs `cargo` on `PATH`; env
  from `installCommand` does not persist into `buildCommand` (separate shells),
  so the build script re-exports it.

### `scripts/vercel-install.sh` — per-line rationale

```bash
set -euo pipefail                 # fail the build on any toolchain error
npm install                        # JS deps (Vercel's normal install step)
export CARGO_HOME=.../node_modules/.cache/cargo    # cache dir Vercel persists
export RUSTUP_HOME=.../node_modules/.cache/rustup  # toolchain lands here → cached
if ! command -v rustup; then       # image ships rustup, so normally skipped;
  curl https://sh.rustup.rs | sh -s -- -y --profile minimal \
      --no-modify-path --default-toolchain none   # bootstrap only if absent
fi
export PATH="$CARGO_HOME/bin:$PATH"
rustup set profile minimal         # no docs/clippy/rustfmt — smaller cache
rustup toolchain install stable    # downloads once (cold), no-op when cached
rustup default stable              # fixes the "no default toolchain" error
cargo --version                    # proves the toolchain is usable
```

### `scripts/vercel-build.sh` — per-line rationale

```bash
set -euo pipefail
export CARGO_HOME=.../node_modules/.cache/cargo
export RUSTUP_HOME=.../node_modules/.cache/rustup    # same as install → finds stable
export CARGO_TARGET_DIR=.../node_modules/.cache/cargo-target  # compiled deps cached too
export PATH="$CARGO_HOME/bin:$PATH"  # /rust/bin/cargo proxy resolves via RUSTUP_HOME
cargo --version                      # fail fast if PATH/toolchain is wrong
npm run build                        # react-router build → Vite plugin → napi build --release
```

Why `node_modules/.cache/*`: Vercel persists `node_modules/.cache` in its build
cache, so the toolchain, cargo registry, compiled crate deps, **and** the
plugin's own `.node` cache (`node_modules/.cache/vite-rust/`) all ride along and
warm builds skip the download + compile.

## Toolchain path that actually applied

**Preinstalled rustup + self-installed toolchain.** The image ships
`rustup` at `/rust/bin/rustup` but with no default toolchain configured — a bare
`cargo --version` errors with *"rustup could not choose a version of cargo to
run… no default is configured."* The script therefore runs `rustup toolchain
install stable` + `rustup default stable` into the cached `RUSTUP_HOME`, giving
**cargo 1.96.1 (stable-x86_64-unknown-linux-gnu)**. The rustup-bootstrap `curl`
branch never fires on the current image.

## Build-log evidence

Compile line proving the plugin ran on-target, and the traced addon landing next
to the server chunk (cold build):

```
[vite-rust] compiling crate "native" (release); first build can take 30s+…
build/server/nodejs_eyJydW50aW1lIjoibm9kZWpzIn0/native-69f4…e0d528.node  547.88 kB
build/server/nodejs_eyJydW50aW1lIjoibm9kZWpzIn0/index.js                 19.23 kB
```

The `.node` sits in the **same dir** as `index.js`, so the build-mode
`new URL("native-<hash>.node", import.meta.url)` resolves at runtime — nft
traced it with zero plugin changes (rung 1 confirmed on real linux).

### Build durations (cold vs warm)

| Build | Deployment | Cache | Toolchain | Crate compile | `Build Completed` | Wall |
|---|---|---|---|---|---|---|
| Cold | `botsprvyi` (preview) | pre-toolchain base | downloaded (~9.7s) | compiled release (~23.3s) | **39s** | 56s |
| "Warm" #1 | `qopaj41ap` (prod) | **miss** — restored the same pre-toolchain base | re-downloaded | **recompiled (24.2s)** | **40s** | 56s |
| Warm #2 | `zrf57b172` (prod) | **hit** — restored `qopaj41ap`'s cache | `unchanged` (no download) | **skipped** (no compile line) | **7s** | 23s |

Warm #2's SSR bundle built in **124 ms** (vs 23–24 s cold) because the plugin's
content-hash `.node` cache was restored and the crate hash was unchanged, so
`napi build` was never invoked. Toolchain reported `unchanged` (restored from
`RUSTUP_HOME` cache). Cargo was not needed at all on the warm build.

## Per-route verification (production `vite-rust-import-plugin.vercel.app`)

| Route | Status | Time | Check |
|---|---|---|---|
| `/` | 200 | 0.23s | HTML home |
| `/static` | 200 | 0.29s | frontend-only route |
| `/api/hello?q=test` | 200 | 0.20s | JSON, `"uppercased":"TEST"` |
| `/slow-io` | 200 | 3.19s | ~3s IO wait |
| `/slow-cpu` | 200 | **18.11s** | digest `09537d1e…` (JS sync 6M loop on 1 vCPU) |
| `/slow-cpu-rust` | 200 | **2.34s** | digest `09537d1e…` (Rust 6M, same digest) |
| `/rust` | 200 | 0.44s | digest `4107c82d…` (Rust 700k) |

Both Rust routes returned the **known-good digests** — `4107c82d…` @700k and
`09537d1e…` @6M — matching the local values exactly. The 6M workload is ~7.7×
faster in Rust (2.34s) than the sync-JS equivalent (18.1s) on the same vCPU.

### Concurrency smoke (5 concurrent `/slow-cpu-rust`, prod)

All 5 returned 200 with the correct digest, no 504s, **6.17s wall**. Individual
times 3.0–6.1s (Fluid multiplexing onto the 2-vCPU instance introduces some
queuing, as VERCEL-PLAN sharp-edge #3 predicted). Critically, `/api/hello`
probed **mid-load returned 200 in 0.29s** — the event loop stayed responsive
because the Rust hash chains run on napi-rs's Tokio pool, not the JS thread.
This is the local "event-loop-freedom" result reproducing on Vercel Fluid.

## Rung 1 in the real deploy

**Held.** `@vercel/nft` traced `new URL("native-<hash>.node", import.meta.url)`
from the build-mode chunk and the builder placed the 504 KB addon at the same
relative path inside the function (`filePathMap` indirection, per VERCEL-RECON
§3f). The linux binary loaded and executed. No rung-3 codegen hint or rung-4
post-build copy was needed.

## Deviations & dead ends (findings for the measurement agent / maintainers)

1. **`installCommand` 256-char limit.** The first deploy with an inline
   `installCommand` failed: *"projectSettings.installCommand should NOT be
   longer than 256 characters."* Fix: move logic into `scripts/*.sh` and call
   `bash scripts/…`. This is why the toolchain logic lives in scripts, not
   `vercel.json`.

2. **Image ships rustup but no default toolchain.** First script version just
   ran `cargo --version` and failed with *"rustup could not choose a version…
   no default is configured."* The cargo proxy at `/rust/bin/cargo` also
   honored our overridden (empty) `RUSTUP_HOME`, so nothing was found. Fix:
   `rustup set profile minimal && rustup toolchain install stable && rustup
   default stable` into the cached `RUSTUP_HOME`. **The `curl | rustup.rs`
   bootstrap in the plan never runs on the current image** — rustup is already
   there; we only needed to give it a toolchain.

3. **First production build did NOT warm from the cold preview build.** The
   cold build was a *preview* deploy; the first *production* deploy
   (`qopaj41ap`) restored the same pre-toolchain cache base
   (`HF1cg5…`) as the cold build — i.e. a cache **miss** — and re-downloaded the
   toolchain and **recompiled the crate (24s)**. Only the *second* production
   deploy (`zrf57b172`) restored the first prod build's cache and went fully
   warm (7s). **Takeaway for the measurement agent:** Vercel's build cache is
   per-lineage/target; don't expect a preview build to warm a production build,
   and expect the *first* build on a new target to pay the full cold cost. Warm
   behavior is real but only within the same target's chain.

4. **Preview deployments are behind Vercel SSO; production is public.** Preview
   URLs 302-redirect to `vercel.com/sso-api` (Deployment Protection). All route
   verification was therefore done on the **production** alias, which is
   publicly reachable. Deployment Protection settings were **not** changed (out
   of scope per the task). If a future agent needs to hit a preview URL
   directly, it needs a protection-bypass token — none was created here.

5. **`vercel deploy` (no flag) on a non-git project deployed to *production*.**
   The Phase 1 baseline `vercel deploy --yes` reported "Deployed to production"
   and aliased `vite-rust-import-plugin.vercel.app`. Later builds used
   `--prod` explicitly for promotion and plain `vercel deploy --yes` produced a
   protected *preview*. So on this project the first bare deploy went to prod;
   subsequent bare deploys went to preview. Use `--prod` explicitly to be sure.

## Reproduce

```bash
vercel deploy --prod --yes          # from the project directory (CLI upload)
# verify:
curl -s https://vite-rust-import-plugin.vercel.app/rust | grep -o '4107c82d[0-9a-f]*'
curl -s https://vite-rust-import-plugin.vercel.app/slow-cpu-rust | grep -o '09537d1e[0-9a-f]*'
```

Working tree left green: `npm run typecheck` clean, `cd plugin && node --test`
11/11 pass, `npm run build` succeeds, `app/routes.ts` fully restored.
