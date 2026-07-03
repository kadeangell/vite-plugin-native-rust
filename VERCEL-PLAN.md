# Upgrade plan: deploy the Rust-import system to Vercel

> **Status: DEPLOYED + MEASURED (2026-07-02).** All build-order steps 0–5 are
> done. Live at https://vite-rust-import-plugin.vercel.app (Vercel Functions,
> Fluid compute, `nodejs24.x`, `iad1`), the addon compiled on-target during
> `vercel build` and traced by nft with **zero plugin/codegen changes —
> mitigation rung 1 held** (V3 ladder). Toolchain reality: the build image
> ships **rustup at `/rust/bin` but no default toolchain**, so the install
> script runs `rustup toolchain install stable && rustup default stable` into a
> cached `RUSTUP_HOME`; the plan's `curl | rustup.rs` bootstrap never fires.
> Deploy evidence: `VERCEL-DEPLOY.md`; packaging recon: `VERCEL-RECON.md`;
> production A/B numbers: `MEASUREMENTS-VERCEL.md`.
>
> **Headline numbers (production, over public internet):** single-request
> ~7.0× (JS `/slow-cpu` 18.3s median vs Rust `/slow-cpu-rust` 2.61s); N=5
> concurrent ~8.4× wall (19.0s vs 2.27s); Rust fan-out scales cleanly to N=10
> (~3.9s wall). Estimated **active-CPU billing ~7×** cheaper for Rust
> (Fluid bills active CPU; wall ≈ CPU for this workload). Cold-start delta with
> the 504 KB addon ≈ **+0.38s** (749ms cold `/rust` vs 367ms warm).
>
> **The serverless twist (corrects the local conclusion):** on Vercel, Fluid
> **fans concurrent requests out to separate instances**, so the sync-JS
> event-loop *starvation* that was Rust's biggest local win **does not happen**
> — `/api/hello` stayed at ~118ms during 5-way JS load (vs ~12.4s starved
> locally). The transferable wins on serverless are **latency (~7×) and cost
> (~7×)**, not availability. See `MEASUREMENTS-VERCEL.md` §Interpretation.
>
> **Packaging reality:** the deploy produced a **single** SSR function (no
> bundle splitting materialized), so sharp-edge #2 stayed hypothetical; the
> addon rides in that one function's `filePathMap`. No explicit `maxDuration`
> is set — the JS `/slow-cpu` route's ~18s runs on the plan default with
> headroom, but see the hardening note below.

## Goal

`git push` (or `vercel deploy`) → the RRv7 app, including routes that
`import { hashChain } from "../native/src/lib.rs"`, runs on Vercel Functions
with the native addon compiled for the target platform and bundled correctly.
Local dev stays exactly as it is today.

**Stance: this should work.** Every required building block exists and is
supported: Vercel's build container and function runtime are the *same
platform* (Amazon Linux 2023, x86_64) — so our locked build-on-target
assumption survives intact; native Node modules are supported in Vercel
Functions; the official `@vercel/react-router` preset handles RRv7 framework
mode; and there's an escape hatch (`includeFiles`) if file tracing needs help.
The work is wiring, not research.

## Established facts (recon, 2026-07)

| Fact | Consequence |
|---|---|
| Vercel build image = Amazon Linux 2023; prebuilt deployment outputs "must be for x86_64 linux" | Build container and function runtime are the same platform → `napi build --release` during `vercel build` produces the right binary. **No cross-compilation needed.** |
| `@vercel/react-router` preset: per-route function config (`memory`, `maxDuration`), **bundle splitting across functions**, custom entry support | Preset is the deploy mechanism. Splitting means more than one function may reference the addon — each one must carry it. |
| Vercel Functions are packaged via `@vercel/nft` static analysis (`require`/`import`/`fs` tracing; `new URL(x, import.meta.url)` is a recognized pattern) | Our build-mode output *already* renders `ROLLUP_FILE_URL` to exactly `new URL("<name>.node", import.meta.url)` — there's a real chance nft traces the binary with **zero changes**. Verify first (Phase 0), mitigate only if needed. |
| Fluid compute multiplexes concurrent requests onto one function instance and bills active CPU | The parallelism bet applies **on Vercel too**: a sync-JS CPU loader blocks every multiplexed request; the Rust async form keeps the instance responsive. Bonus: ~2.9× less CPU = lower Fluid compute bill. |
| Functions have a read-only filesystem (except `/tmp`), 250 MB limit | Fine: the addon is 504 KB and we never write at runtime (`.d.rs.ts` writes are build-time). |

## What changes (and what doesn't)

Unchanged: local dev flow, the plugin's resolve/load/compile/cache pipeline,
the crate, the generated dev JS shape, TypeScript story.

Changes:
1. `react-router.config.ts` gains `presets: [vercelPreset()]` (+ dev dep
   `@vercel/react-router`).
2. Vercel project config: install Rust in the build container if absent, and
   cache the cargo bits between builds.
3. Possibly nothing else — Phase 0 decides whether the addon needs an
   inclusion assist (mitigation ladder below).

## Locked decisions

### V1 — Build the crate on Vercel, not locally

`vercel build` runs on AL2023 x86_64 = the runtime platform, so the existing
plugin compiles the right binary as a side effect of the normal build. No
`--prebuilt` deploys from macOS (that would ship a darwin binary); no zig
cross-compile toolchain. This is the same "build on target platform"
assumption PLAN.md already locked.

### V2 — Toolchain via installCommand, cache under `node_modules/.cache`

- `installCommand`: `npm install && (command -v cargo || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal)` (exact form decided in Phase 2; check first whether AL2023 image already ships cargo via dnf).
- Set `CARGO_HOME=node_modules/.cache/cargo` and
  `CARGO_TARGET_DIR=node_modules/.cache/cargo-target` (env vars, no plugin
  change) — Vercel persists `node_modules/.cache` in its build cache, so
  warm builds skip both the registry fetch and most of the compile. Our
  plugin's own `.node` cache already lives in `node_modules/.cache/vite-rust`
  and rides along for free.

### V3 — Addon inclusion: verify-first mitigation ladder

> **RESOLVED by Phase 0 recon (see VERCEL-RECON.md): Rung 1 holds.** nft
> traces `new URL("native-<hash>.node", import.meta.url)` and packages the
> addon at the correct relative path via the function's `filePathMap` — zero
> plugin/config changes. Verified including a forced bundle split (each
> function got its own correctly-traced copy). Corrections from recon:
> rung 2 is **dead** (the RR/Remix builder ignores `includeFiles`); the real
> fallback if rung 1 ever regresses is rung 3; rung 4 would also have to
> patch each function's `filePathMap`, making it worse than assumed.

1. **Nothing.** ✅ CONFIRMED — see above.
2. ~~`includeFiles`~~ — not supported by the RR builder; dead rung.
3. **Plugin emits an nft hint** — the actual fallback: one statically
   analyzable `new URL(...)` line in build-mode codegen (~3 lines).
4. **Post-build copy** — last resort; must patch `filePathMap` too.

### V4 — Fluid compute ON, and it's part of the story

> **CORRECTED by measurement (see status header + MEASUREMENTS-VERCEL.md):**
> the premise below turned out wrong. Fluid **fanned concurrent requests out
> to separate instances** rather than multiplexing them onto one, so the
> local event-loop-starvation win did not transfer. What did transfer — and
> grew — is latency (~7×) and active-CPU cost (~7×). The paragraph below is
> kept as the original hypothesis for the record.

Fluid is where the event-loop-freedom result transfers to serverless: one
instance serving many multiplexed requests behaves like our local
5-concurrent test. Measure with it on (default for new projects). Also
measure the CPU-billing delta — Rust doing the same work in ~1/3 the CPU time
is a direct cost reduction under Fluid's active-CPU pricing.

## Sharp edges

1. **nft can't see the hidden require — by design.** The whole plugin works by
   hiding the `require` from bundlers; Vercel's tracer is another static
   analyzer. The saving grace is that Rollup's *rendered* output re-exposes a
   pattern nft understands (`new URL(..., import.meta.url)`). If that fails,
   the V3 ladder has three more rungs. This is the only genuinely novel risk
   in the whole upgrade, and it has four independent solutions.
2. **Bundle splitting.** The preset may split routes into several functions;
   every function whose chunks reference the addon needs its own copy at the
   right relative path. Test with two Rust-importing routes that land in
   different functions (we have `/rust` and `/slow-cpu-rust` already).
3. **vCPU ceiling.** Locally the Tokio pool had 10 cores; a Vercel function
   has 1–2 vCPUs depending on memory tier. Expect the concurrency win to show
   up as "event loop stays free + Fluid keeps multiplexing" rather than
   "10 hash chains run simultaneously." Set expectations in the measurement
   report; try both standard and performance CPU tiers.
4. **Build minutes.** Cold cargo build on Vercel ~1–3 min. V2's caching makes
   warm builds cheap; the plugin's hash cache skips the compile entirely when
   crate sources are unchanged.
5. **This scratchpad is not a git repo.** Either `git init` + GitHub for the
   normal flow, or `vercel deploy` straight from the directory (CLI uploads
   sources and builds remotely — still build-on-target). Decide at Phase 1.
6. **NODE_ENV=production** bit us with `react-router-serve` locally; on Vercel
   the preset supplies its own entry (not `react-router-serve`), so this
   should be moot — but keep it on the Phase 1 checklist.

## Build order (spike-first, same discipline as PLAN.md)

0. **Packaging recon (no deploy, ~zero cost).** `npm i -D @vercel/react-router`,
   add the preset, run `vercel build` (or plain `react-router build` +
   preset) **locally on macOS** — the binary will be darwin (irrelevant), but
   `.vercel/output/` reveals everything that matters: how many functions, where
   server chunks land, whether the `.node` asset was traced into the
   function dirs, and what `.vc-config.json` looks like. Also read the
   preset's source in node_modules to see how it invokes nft and whether it
   honors `includeFiles`. **This answers V3 before any deploy.**
1. **Baseline deploy (JS only).** Create the Vercel project (decide git vs
   CLI, sharp edge 5). Temporarily exclude the Rust routes (comment out two
   lines in `app/routes.ts`), deploy, verify `/`, `/slow-io`, `/slow-cpu`,
   `/api/hello` all work in production. Proves preset + app before Rust
   enters.
2. **Rust toolchain in the build.** Restore the Rust routes. Configure V2
   (installCommand + cargo env vars). Deploy; confirm from build logs that
   the crate compiled (release), and whether the toolchain was preinstalled
   or rustup-installed. Confirm warm-build cache hit on a no-change redeploy.
3. **Addon inclusion.** Hit `/rust` and `/slow-cpu-rust` in production.
   If 500 (addon missing from bundle): walk the V3 ladder, redeploy, repeat.
   Acceptance: both routes return the known digests
   (`4107c82d…` at 700k, `09537d1e…` at 6M) from the deployed URL.
4. **Measure on Vercel** (the payoff, mirroring MEASUREMENTS.md): single-request
   latency JS vs Rust; N-concurrent wall time against one warm instance
   (Fluid); `/api/hello` responsiveness during load; cold-start delta with the
   addon; CPU-time billing comparison from the Vercel dashboard. Write
   `MEASUREMENTS-VERCEL.md` with the same honesty bar — including where
   serverless changes the local conclusions (vCPU ceiling, per-instance
   concurrency limits).
5. **Docs + hardening.** Deploy instructions in the plan docs; pin the
   mitigation rung V3 landed on; note the `maxDuration` for the demo routes;
   confirm `vercel dev` still delegates to vite dev untouched. **Done — see
   the hardening notes below and `MEASUREMENTS-VERCEL.md`.**

## Hardening notes (post-measurement, 2026-07-02)

**`maxDuration` — the plan's ~800 ms estimate for the 6M route was wrong.**
On Vercel's vCPU the *JS* `/slow-cpu` route takes **~18.3 s**, not sub-second
(the ~800 ms figure was the local Rust time). No explicit `maxDuration` is set,
so every route runs on the plan default; `/slow-cpu` succeeded 5/5 at ~18 s
including under N=5 concurrency, so the effective default is comfortably above
~19 s here. Still, an 18 s request with no explicit cap is fragile:

- **Recommended (not applied — no redeploy):** set a per-route `maxDuration`
  via the `@vercel/react-router` preset's route config for the JS `/slow-cpu`
  route — e.g. **`maxDuration: 60`** — so a heavier input or a slower cold
  vCPU can't silently 504. The Rust routes (`/slow-cpu-rust` ~2.6 s, `/rust`
  ~0.4 s) are safe under any default and need nothing.
- **The real fix is the plugin itself:** `/slow-cpu` is the *unported* JS
  baseline kept for the A/B. In a real app you would port it to Rust exactly
  like `/slow-cpu-rust` — which both removes the timeout risk and cuts the
  active-CPU bill ~7× (see `MEASUREMENTS-VERCEL.md` §Cost). Bumping the memory
  tier would raise the coupled vCPU and shave the JS time, but at higher cost;
  porting the hot path is strictly better.

**`vercel dev` confirmed untouched by the preset wiring.** `vercel dev` runs
`react-router dev` (= vite dev); hitting `/rust` through the underlying vite
server returned the correct `4107c82d…` digest in ~2.6 s including the first
debug cargo compile — the plugin's dev resolve/load/compile/cache pipeline works
exactly as before. (Aside: the `vercel dev` *proxy port* itself returned
`000`/timeout on this machine even for `/`; that is a CLI-proxy quirk unrelated
to the preset or the plugin — vite dev underneath is healthy.)

## Out of scope

- Cross-compiling from macOS for `--prebuilt` deploys (napi + zig can do it;
  only revisit if Vercel-side builds become a bottleneck).
- Edge runtime (native addons are Node-runtime-only, permanently).
- Multi-region function replication concerns (the addon travels with the
  function bundle; nothing region-specific).
- Other serverless targets (AWS Lambda direct, Cloudflare — Workers can't
  dlopen at all).
