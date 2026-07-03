# Benchmarks

Two measurement sets: **local** (a single machine) and **Vercel** (serverless).
They reach *different* conclusions, and the difference is the interesting part —
serverless neutralizes one of Rust's local advantages while amplifying another.
Everything here is reproducible; the raw measurement records live in the repo at
[`MEASUREMENTS.md`](../MEASUREMENTS.md) and
[`MEASUREMENTS-VERCEL.md`](../MEASUREMENTS-VERCEL.md).

## The workload

One function, two implementations of the identical computation:

| Route | Loader | Where the work runs |
| --- | --- | --- |
| `/slow-cpu` | synchronous `heavyHashChain()` in JS | Node main thread — blocks the event loop |
| `/slow-cpu-rust` | `await hashChain(6_000_000)`, an `#[napi] async fn` | off-thread, returns a real Promise |

Both run a 6,000,000-iteration SHA-256 hash chain seeded with
`"vite-rust-import-plugin"`, and **both render the same digest**
(`09537d1e…`), so this is a true A/B of one workload — not two different
computations. This is pure CPU work; see the caveats at the end.

## Local

Environment: Apple M5, 10 cores, 24 GB RAM, macOS 26.5.1, Node v25.8.1, rustc
1.96.0, release profile, served by `@react-router/serve` with
`NODE_ENV=production`, single process. Latency is the full client round trip
(`fetch` + draining the body) via `performance.now()` on localhost; every route
is warmed once before timing.

### Single-request latency (median of 3)

| Route | Median |
| --- | --- |
| JS `/slow-cpu` | 2255.9 ms |
| Rust `/slow-cpu-rust` | 782.0 ms |

**~2.9× faster per request** on raw compute alone — single-threaded Rust SHA-256
vs. Node's `crypto.createHash` loop, before any concurrency benefit and before
rayon enters.

### 5 concurrent requests

| Route | Per-request latency (sorted, ms) | Wall (ms) |
| --- | --- | --- |
| JS `/slow-cpu` | 11485.3 … 11485.7 | **11486** |
| Rust `/slow-cpu-rust` | 1044.3 … 1075.7 | **1076** |

This is the local headline. JS **serializes**: each of the 5 requests takes
~11.5 s (≈ 5× the single-request time) because each synchronous hash chain holds
the one event loop while the other four wait. Rust **parallelizes**: all 5 finish
in ~1.08 s, barely more than a single request, each on its own worker thread.
**Wall-clock speedup at 5-way concurrency: ~10.7×.**

### Event-loop responsiveness (the availability win)

While those 5 concurrent requests were in flight, a trivial `/api/hello`
(~1 ms of work) endpoint was probed every ~200 ms:

| During load on | Probes completed | Median probe latency |
| --- | --- | --- |
| JS `/slow-cpu` | 1 | **12393 ms** (starved) |
| Rust `/slow-cpu-rust` | 6 | **1.7 ms** |

Under JS load the event loop is fully jammed — a single probe returned, after
~12.4 s. Under Rust load the same endpoint stayed at 1–2 ms throughout. **This is
the difference between "one expensive loader takes the whole server down" and
"one expensive loader costs one thread."** Locally, this is Rust's biggest
practical win.

### Thread-pool sizing — a correction to the original premise

The project plan expected napi async fns to run on the **libuv** pool (default
`UV_THREADPOOL_SIZE=4`) and to queue past 4 concurrent requests. **The data says
otherwise.** Wall time stays essentially flat from N=1 through N=10, then roughly
doubles between N=10 and N=12 — the step-up is at the **core count (10)**, not at
4. And setting `UV_THREADPOOL_SIZE=8` changed nothing structural.

**Why:** napi-rs drives `#[napi] async fn` on its bundled **Tokio** runtime,
whose worker pool defaults to available parallelism (= cores), not on libuv's
pool. `UV_THREADPOOL_SIZE` would govern `AsyncTask`/`execute`-style exports, but
not the `async fn` form. The knob self-sizes to the hardware; there is nothing to
tune unless you switch an export to the `AsyncTask` form.

## Vercel (serverless)

Environment: `https://vite-rust-import-plugin.vercel.app`, Vercel Functions with
Fluid compute (defaults), `nodejs24.x`, function region `iad1`, client over the
public internet. The 504 KB release addon was compiled on-target and traced by
nft. Same methodology, but every number now includes a real SFO→IAD round trip —
the trivial `/api/hello` route measured a **median 117 ms**, which is the network
floor to subtract. Medians are trustworthy; single absolute numbers carry
public-internet variance.

### Single-request latency (median of 5)

| Route | Median |
| --- | --- |
| JS `/slow-cpu` | 18302 ms |
| Rust `/slow-cpu-rust` | 2614 ms |

**~7.0× faster per request** (18302 / 2614). Subtracting the 117 ms floor: ~18.2 s
of JS compute vs. ~2.5 s of Rust compute, a ~7.3× compute ratio.

Why the ratio more than doubled vs. local's 2.9×: the Vercel vCPU is slower than
the M5 for both, but it punishes JS **far** more (8.1× slower) than Rust (3.3×
slower) — Node's `crypto.createHash` loop degrades harder on the weaker x86 core
than native SHA-256 does. **The slower the CPU, the bigger Rust's win here.**

### The fan-out correction (told straight)

Locally, 5 concurrent JS requests took ~11.5 s wall because they serialized on one
event loop. On Vercel:

| Route | Per-request latency (sorted, ms) | Wall (ms) |
| --- | --- | --- |
| JS `/slow-cpu` | 17545 … 18971 | **18974** |
| Rust `/slow-cpu-rust` | 2014 … 2264 | **2269** |

**All five 18 s JS requests finished in ~19 s wall — the same as one request.**
Five requests that each peg a CPU for 18 s cannot complete in 19 s on one shared
event loop; Fluid **fanned them out to separate instances**, each running one
request in parallel (corroborated by five distinct `x-vercel-id` tokens). So on
Vercel *even JS "parallelizes"* — not by freeing the event loop, but by giving
each request its own event loop on its own instance.

The consequence, measured directly: probe `/api/hello` during 5 concurrent heavy
requests —

| During load on | Median probe latency |
| --- | --- |
| JS `/slow-cpu` | **118 ms** (just the network floor) |
| Rust `/slow-cpu-rust` | **116 ms** |

**The starvation that dominates the local JS result does not happen on Vercel.**
The probe is routed to an instance that isn't running a blocking hash chain, so it
never contends for a jammed event loop. This works *against* one of Rust's local
advantages, so it is reported plainly: on serverless the availability argument for
Rust largely evaporates — the platform already solves it by fanning out.

Fan-out held to at least N=10 (ten concurrent 6M-Rust requests returned in ~3.9 s
wall, no serialization cliff). The ~4 s plateau under a rapid burst is
autoscaling lag as Fluid spins up instances, not serialization — bounded and
small.

### Cost — the ~7× is a direct multiplier

Fluid bills **active CPU time**. For these CPU-bound requests, wall time ≈ active
CPU time (JS pegs the main thread its whole duration; the Rust request is
dominated by ~2.5 s of off-thread SHA-256), and both routes run at the same
memory tier.

> **Estimated active-CPU billing ratio ≈ 18.3 s / 2.6 s ≈ 7.0× per request.**
> Serving the 6M workload in Rust costs roughly one-seventh the Fluid compute
> bill of the JS version, for identical output — and it compounds under sustained
> concurrency, since each in-flight JS request ties up billable instance-time ~7×
> longer.

This is derived from measured wall times as an active-CPU proxy — directionally
solid, but label it an estimate, not a dashboard reading.

### Cold start

The ~500 KB addon adds only **+0.35–0.38 s** to a cold instance boot (measured
against a warm follow-up on the fast `/rust` route). A native `dlopen` on function
init is cheap; Fluid's boot plus the network round trip dominate the ~720–750 ms
cold figure. Instances stay warm for minutes, so a busy app rarely pays this.

## Bottom line

- **Locally**, the headline is **availability** (don't let one request take down
  the box) plus ~2.9× raw speed and ~10.7× concurrent throughput.
- **On serverless**, the platform already solves availability by fanning out, so
  the headline becomes **~7× faster responses and ~7× lower active-CPU cost** for
  the same computation.

Either way, the plugin's value — writing the hot path in Rust with a plain
`import { hashChain } from "./native/src/lib.rs"` — carries to production
unchanged.

## Caveats (honest)

- **This is pure CPU work.** If your real bottleneck is I/O, none of this speedup
  applies — see [when-not-to-use.md](when-not-to-use.md).
- **First-compile latency (dev only).** The first request that touches a crate
  triggers a cargo compile (tens of seconds cold); subsequent requests hit the
  content-hash cache, and the production binary is baked into the build.
- **The parallelism ceiling is finite.** Locally it's the core count; on Vercel
  it's the account concurrency cap and autoscaling speed. Rust buys a much higher
  and faster ceiling than the JS event loop (which is 1), not an infinite one.
- **Serverless numbers include public-internet variance.** Medians are reliable;
  individual absolute samples (one 20 s Rust cold spike, a couple of ~0.5–0.9 s
  probe bumps) less so. The fan-out finding rests on timing that is dispositive
  (5×18 s of work in ~19 s wall), with the instance tokens as corroboration.
