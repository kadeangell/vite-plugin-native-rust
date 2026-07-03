# Measurements: JS vs Rust on Vercel (serverless)

The same A/B as `MEASUREMENTS.md`, re-run against the **deployed** app on
Vercel Functions (Fluid compute). The workload is identical — a
6,000,000-iteration SHA-256 hash chain seeded with `"vite-rust-import-plugin"`
— and both routes still render the same digest, so this remains a true A/B of
one workload:

```
09537d1e2233662548a7d16a00b37bcb5b131b248f3d5fc6a5e3dd39dfcd7320
```

The headline is that **serverless changes the conclusion**. Locally, Rust's
biggest win was *availability* (a sync-JS loader jams the single event loop and
starves all other traffic). On Vercel that problem **does not occur**: Fluid
fans concurrent requests out to separate instances, so a blocking JS request
never starves an unrelated probe. What survives — and is arguably more
important on serverless — is **raw latency (~7×)** and the **active-CPU billing
that tracks it (~7×)**.

## Environment

| | |
|---|---|
| Target | `https://vite-rust-import-plugin.vercel.app` (production alias) |
| Runtime | Vercel Functions, Fluid compute (defaults), `nodejs24.x` |
| Function region | `iad1` (Washington DC) — from `x-vercel-id` |
| Client | this machine (macOS), over the public internet; edge PoP `sfo1` |
| Native binary | 504 KB release addon, on-target `napi build --release`, traced by nft |
| Deploy record | `VERCEL-DEPLOY.md` (Phases 1–3), recon in `VERCEL-RECON.md` |

**Methodology.** Node built-ins only (`scripts/measure-vercel.mjs`), mirroring
`MEASUREMENTS.md`: every route gets a warmup hit before timing; latency = full
client round trip (`fetch` + draining the body) via `performance.now()`;
sequential samples are spaced 300 ms, concurrent batches spaced ≥2 s to be
polite; total requests capped in the low hundreds.

**Network floor.** Unlike the local run (localhost, sub-ms RTT), every number
here includes a real SFO→IAD round trip. The trivial `/api/hello` route
(~1 ms of server work) measured a **median 117 ms** — treat that as the network
floor and subtract it to recover compute time. Absolute numbers carry public-
internet variance (a few of the samples below show it); medians are the
trustworthy figures, and one Rust single-request sample hit a 20 s cold-instance
spike that the median ignores.

---

## 1. Single-request latency

Median of 5 sequential samples (post-warmup), spaced 300 ms.

| Route | Samples (ms) | Median (ms) |
|---|---|---|
| JS `/slow-cpu` | 18008, 18180, **18302**, 18316, 18728 | **18302** |
| Rust `/slow-cpu-rust` | 2285, 2300, **2614**, 3308, 20100¹ | **2614** |
| Rust `/rust` (700k) | 363, 382, **391**, 419, 438 | **391** |
| JSON `/api/hello` | 109, 116, **117**, 196, 214 | **117** |

¹ one cold-instance spike; the median is unaffected.

**Rust is ~7.0× faster per request** for the 6M workload on the same
infrastructure (18302 / 2614). Subtracting the 117 ms network floor: ~18.2 s of
JS compute vs ~2.5 s of Rust compute — a ~7.3× compute ratio.

The 700k `/rust` route lands at 391 ms (~274 ms compute), and `/api/hello` at
117 ms is essentially pure network.

## 2. Concurrency A/B and the fan-out finding

Five truly concurrent requests (`Promise.all` of 5 `fetch`es), post-warmup.

| Route | Per-request latency (ms, sorted) | Wall (ms) |
|---|---|---|
| JS `/slow-cpu` | 17545, 17744, 17843, 18260, 18971 | **18974** |
| Rust `/slow-cpu-rust` | 2014, 2253, 2255, 2263, 2264 | **2269** |

**This is where the local conclusion inverts.** Locally, 5 concurrent JS
requests took ~11.5 s wall — each waited its turn on the single event loop
(≈5× the single-request time). On Vercel, **all five 18 s JS requests finished
in ~19 s wall — the same as one request.** Five requests that each peg a CPU
for 18 s cannot complete in 19 s on one shared event loop; Fluid **fanned them
out to separate instances**, each running one request in parallel. The five
responses also carried five distinct `x-vercel-id` instance tokens, consistent
with fan-out (the timing alone is dispositive; the token is corroborating, not
proof of distinct hardware).

So on Vercel *even JS "parallelizes"* — not by freeing the event loop, but by
giving each request its own event loop on its own instance. Wall speedup at
N=5 is 18974 / 2269 = **~8.4×**, but that number mostly reflects Rust's per-
request speed, not a serialization gap, because JS no longer serializes here.

### Rust scaling curve (N = 2, 5, 10)

Fired as a rapid burst (batches ~2 s apart) to probe how fan-out holds up.

| N | Wall (ms) | Per-request spread (ms) |
|---|---|---|
| 2 | 4030 | 4029–4030 |
| 5 | 4011 | 2385–4009 |
| 10 | 3947 | 3644–3947 |

Two honest observations:

1. **Fan-out scales to at least N=10.** Ten concurrent 6M-Rust requests all
   returned 200 in ~3.9 s wall — nowhere near 10× the single-request time.
   There is no serialization cliff at 1–2 vCPU the way there is at the core
   count locally; Vercel adds instances instead of queuing on one.
2. **The ~4 s plateau is burst/autoscaling lag, not serialization.** These
   batches fired 2 s apart, so later ones raced Fluid spinning up additional
   instances (cold-ish), which adds ~1.5 s over the freshly-warmed headline
   figure (2.27 s at N=5 above). It is the cost of *scaling out under a sudden
   burst*, and it is bounded and small — not the runaway 5×/10× growth a single
   shared event loop would show.

**Multiplex vs fan-out, answered:** at this concurrency Fluid **fans out to
multiple instances**. In-instance multiplexing (several requests sharing one
instance's event loop) would have reproduced the local starvation — and it did
not (see §3).

## 3. Responsiveness under load — the starvation that doesn't happen

Probe `/api/hello` (~1 ms of work) every ~200 ms while 5 concurrent heavy
requests are in flight.

| During load on | Probes completed | Min (ms) | Median (ms) | Max (ms) |
|---|---|---|---|---|
| JS `/slow-cpu` (18.5 s wall) | 54 | 108 | **118** | 873 |
| Rust `/slow-cpu-rust` (4.0 s wall) | 13 | 102 | **116** | 187 |

Compare to the **local** result, where JS load starved the same endpoint to a
single 12,393 ms response and Rust kept it at 1–2 ms.

**On Vercel the probe is unaffected by JS load** — median 118 ms during JS load
vs 116 ms during Rust load, both just the network floor. The reason is exactly
the fan-out from §2: the probe is routed to an instance that is *not* running a
blocking hash chain, so it never contends for a jammed event loop. Two probes
near the end of the JS burst bumped to 491/873 ms (a warm-instance handoff),
but nothing resembling starvation.

**Key answer:** Fluid starvation **does not happen** here. The local
"one expensive JS loader = self-inflicted outage" result is an artifact of the
single-process model and **does not transfer to Vercel's fan-out architecture.**
This is the most important way serverless changes the local story, and it works
*against* one of Rust's local advantages — so we report it plainly.

## 4. Cold start (504 KB addon)

`/rust` was chosen for the cold probe (fast, ~0.4 s warm, so the delta is the
boot cost, not compute). Two samples, each after a deliberate idle with **no
warmup**, immediately followed by a warm hit for the delta:

| Idle before | Cold `/rust` (ms) | Warm follow-up (ms) | Cold-start delta (ms) |
|---|---|---|---|
| ~6 min | 749 | 367 | **+382** |
| ~9 min | 720 | 375 | **+345** |

**Cold-start delta ≈ +0.35–0.38 s with the 504 KB addon loaded.** The cold and
warm hits landed on different `x-vercel-id` instance tokens each time, so these
are genuine fresh-instance boots. The native addon does **not** impose a large
cold penalty — a ~500 KB `dlopen` on function init is cheap, and Fluid's boot
plus the SFO→IAD round trip dominate the ~720–750 ms cold figure. (Both samples
still include the ~117 ms network floor.) Idle-to-cold on Fluid is not
instantaneous — instances stay warm for minutes — so a busy demo rarely pays
this; it is a floor, not a typical latency.

---

## Interpretation — how Vercel changes the local conclusions

### Single-request speedup grew: 2.9× → ~7.0×

| Route | Local (M5) | Vercel (iad1 vCPU) | Vercel ÷ Local (slowdown) |
|---|---|---|---|
| JS `/slow-cpu` | 2256 ms | 18302 ms | **8.1× slower** |
| Rust `/slow-cpu-rust` | 782 ms | 2614 ms | **3.3× slower** |
| Rust-vs-JS ratio | **2.9×** | **7.0×** | — |

The Vercel vCPU is much slower than the M5 for both — but it punishes JS
**far** more than Rust (8.1× vs 3.3×). So Rust's relative advantage for this
workload *more than doubled* moving to the weaker serverless vCPU: Node's
`crypto.createHash` loop degrades harder on the slower/older x86 core than the
native SHA-256 does. **The slower the CPU, the bigger Rust's win here.**

### The parallelism story lands somewhere new

Locally the win had two parts: raw speed *and* concurrency/availability
(event-loop freedom). On Vercel:

- **Concurrency is provided by the platform, not the language.** Fluid fans
  out to separate instances, so both JS and Rust "parallelize" across requests.
  The event-loop-freedom advantage that mattered locally is **neutralized** —
  a blocking JS request costs one instance for its duration, and other traffic
  routes elsewhere.
- **What remains is per-request speed** (§1) and everything downstream of it:
  cost (below), timeout headroom, and how fast each instance is freed for reuse.
  Fan-out is bounded (burst latency in §2; account-level concurrency caps), and
  a JS request holds its instance ~7× longer, so Rust still buys a materially
  higher effective throughput ceiling per unit of capacity.

### Cost: Fluid bills active CPU — the ~7× is a direct multiplier

Fluid compute bills **active CPU time** (GB-seconds of CPU actually consumed).
For these CPU-bound requests, wall time ≈ active CPU time (JS pegs the main
thread for its whole duration; the Rust request is dominated by ~2.5 s of
off-thread SHA-256). Both routes run at the same memory tier, so GB-seconds
scale with CPU-seconds.

> **Estimated active-CPU billing ratio ≈ 18.3 s / 2.6 s ≈ 7.0× per request.**
> Serving the 6M workload in Rust costs roughly **one-seventh** the Fluid
> compute bill of the JS version, for identical output. Under sustained
> concurrency this compounds: each in-flight JS request ties up billable
> instance-time ~7× longer. (Estimate derived from measured wall times as a
> proxy for active CPU; label accordingly. A dashboard-reported "active CPU"
> figure would refine it but was not pulled here — settings/dashboard were
> out of scope for this measurement pass.)

### Bottom line

On Vercel, Rust via the `.rs` import plugin is still a clear win, but for a
**different reason than locally**. Locally the headline was *availability*
(don't let one request take down the box). On serverless the platform already
solves availability by fanning out; the headline becomes **latency and cost** —
~7× faster responses and ~7× lower active-CPU billing for the same computation,
plus comfortable `maxDuration` headroom (§ hardening in `VERCEL-PLAN.md`). The
plugin's whole value — writing the hot path in Rust with a plain
`import { hashChain } from "../native/src/lib.rs"` — carries to production
unchanged.

### Honest caveats

- **Public-internet variance.** Every latency includes SFO→IAD RTT (~117 ms
  floor) and occasional spikes (one 20 s Rust single-sample; two ~0.5–0.9 s
  probe bumps). Medians are reliable; single absolute numbers less so.
- **Fan-out is inferred primarily from timing.** 5×18 s of JS work finishing
  in ~19 s wall cannot happen on one shared event loop — that is dispositive.
  Distinct `x-vercel-id` tokens corroborate but the token is not a guaranteed
  per-instance fingerprint.
- **Concurrency tested to N=10, low hundreds of requests total.** We did not
  probe the account concurrency ceiling or sustained-load autoscaling behavior;
  the ~4 s burst plateau is a hint, not a full saturation curve.
- **Billing ratio is an estimate** from wall time as an active-CPU proxy, not a
  dashboard reading. Directionally solid (~7×); treat the exact figure as ±.
- **Same workload caveat as local:** this is pure CPU. If a real bottleneck is
  I/O, none of this applies.
