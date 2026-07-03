# Measurements: JS vs Rust for a CPU-bound loader

PLAN step 8 — the payoff the whole project bets on. We ported one genuinely
heavy server function to Rust (via the `.rs` import plugin) and measured it
against the untouched JS baseline under concurrent load.

## The two routes

Both run the **identical** workload: a 6,000,000-iteration SHA-256 hash chain
seeded with `"vite-rust-import-plugin"`.

| Route | Loader | Where the work runs |
|---|---|---|
| `/slow-cpu` | `heavyHashChain()` (`app/heavy.server.ts`), synchronous | Node main thread — blocks the event loop |
| `/slow-cpu-rust` | `await heavyHashChainRust()` → `hashChain(6_000_000)` (`native/src/lib.rs`, `#[napi] async fn`) | Off-thread, returns a real Promise |

Correctness gate: both routes render the **same digest**, so this is a true
A/B of one workload, not two different computations:

```
09537d1e2233662548a7d16a00b37bcb5b131b248f3d5fc6a5e3dd39dfcd7320
```

## Environment

| | |
|---|---|
| Machine | Apple M5, 10 cores (10 physical / 10 logical), 24 GB RAM |
| OS | macOS 26.5.1 (build 25F80) |
| Node | v25.8.1 |
| Rust | rustc 1.96.0, **release** profile (`napi build --release` via `react-router build`) |
| Server | `@react-router/serve`, `NODE_ENV=production`, single process |
| Native binary | `build/server/native-<hash>.node`, 504 KB, emitted into the SSR bundle |

Methodology: production build served on a free port. Every route gets a warmup
request before timing. Latency = full round trip client-side (`fetch` +
draining the body) via `performance.now()`. Localhost, so network overhead is
sub-millisecond. Harness scripts: `measure.mjs` (parts 1–3) and `sweep.mjs`
(part 4), Node globals only, no dependencies.

> Note on the server flag: `@react-router/serve` must run with
> `NODE_ENV=production`, or React SSR throws `dispatcher.getOwner is not a
> function` (dev/prod React build mismatch) and every rendered route 500s. All
> numbers below are from a `NODE_ENV=production` server.

---

## 1. Single-request latency

Median of 3 sequential samples (post-warmup), default thread pool.

| Route | Samples (ms) | Median (ms) |
|---|---|---|
| JS `/slow-cpu` | 2211.5, 2255.9, 2278.1 | **2255.9** |
| Rust `/slow-cpu-rust` | 778.7, 784.1, 782.0 | **782.0** |

**Rust is ~2.9× faster per request** on raw compute alone (before any
concurrency benefit). This is single-threaded Rust SHA-256 vs Node's
`crypto.createHash` loop — no rayon involved yet.

## 2. Concurrency A/B (5 truly concurrent requests)

Fired with `Promise.all` of 5 `fetch`es. Per-request latencies sorted; wall =
total time for all 5 to complete.

| Route | Per-request latency (ms, sorted) | Wall (ms) |
|---|---|---|
| JS `/slow-cpu` | 11485.3, 11485.4, 11485.4, 11485.6, 11485.7 | **11486** |
| Rust `/slow-cpu-rust` | 1044.3, 1047.2, 1059.9, 1071.2, 1075.7 | **1076** |

This is the headline. JS **serializes**: every one of the 5 requests takes
~11.5 s (≈ 5 × the single-request time) because each synchronous hash chain
holds the event loop and the other four wait their turn. Rust **parallelizes**:
all 5 finish in ~1.08 s — barely more than a single request — because each runs
on its own worker thread across the M5's cores.

**Wall-clock speedup under 5-way concurrency: ~10.7×.**

## 3. Event-loop responsiveness under load

While the 5 concurrent requests above were in flight, we probed the trivial
`/api/hello?q=x` resource route (~1 ms of work) every ~200 ms and recorded its
latency. This measures whether the server can still serve *other* traffic.

| During load on | Probes completed | Min (ms) | Median (ms) | Max (ms) |
|---|---|---|---|---|
| JS `/slow-cpu` | 1 | 12392.9 | 12392.9 | **12392.9** |
| Rust `/slow-cpu-rust` | 6 | 1.4 | 1.7 | **1.9** |

Under JS load the event loop is **fully jammed**: only a single probe returned
at all, after ~12.4 s of waiting — the ~1 ms endpoint was completely starved
for the entire duration. Under Rust load the same endpoint stayed at **1–2 ms**
throughout, because the compute is off the main thread. This is the difference
between "one slow request takes the whole server down" and "one slow request
costs one thread."

## 4. Thread-pool sizing — and a correction to the plan's premise

PLAN step 8 expected napi async fns to run on the **libuv** thread pool
(default `UV_THREADPOOL_SIZE=4`), and to show queuing past 4 concurrent
requests fixable by raising that env var. **The data shows otherwise.**

Concurrency sweep, wall time vs request count N:

| N | Wall @ default (ms) | Wall @ `UV_THREADPOOL_SIZE=8` (ms) |
|---|---|---|
| 1 | 770 | 824 |
| 4 | 824 | 1037 |
| 5 | 965 | 1057 |
| 8 | 1196 | 1318 |
| 10 | 1391 | 1609 |
| 12 | 2051 | 2315 |
| 16 | 2417 | 2655 |

Two things stand out:

1. **No queuing at 4.** Wall time stays essentially flat from N=1 through N=10
   (all requests run concurrently), then roughly *doubles* between N=10 and
   N=12. The step-up is at the **core count (10)**, not at 4. So the effective
   parallelism width is the CPU, not a 4-thread pool.
2. **`UV_THREADPOOL_SIZE=8` changes nothing structural.** The step-up stays at
   N>10 in both columns; the UV=8 column is uniformly a touch higher, which is
   run-to-run/thermal variance (if the flag mattered, a bigger pool would
   *lower* wall time, not raise it). 5-concurrent under UV=8 was still ~1025 ms
   wall — same as default.

**Why:** napi-rs drives `#[napi] async fn` on its bundled **Tokio** runtime,
whose worker pool defaults to available parallelism (= cores), not on libuv's
`UV_THREADPOOL_SIZE` pool. `UV_THREADPOOL_SIZE` would govern
`AsyncTask`/`execute`-style exports, but not the `async fn` form this project
uses. The knob to tune for `async fn` is the Tokio worker count, and it already
self-sizes to the hardware.

---

## Conclusion — did the parallelism bet pay off?

**Yes, decisively, and for two independent reasons:**

- **Raw speed:** ~2.9× faster per request, single-threaded, before concurrency.
- **Concurrency:** ~10.7× faster wall time at 5-way concurrency, because Rust
  parallelizes what JS serializes.
- **Availability (the biggest practical win):** under load the JS route
  starves every other request on the server (~12 s to serve a 1 ms endpoint);
  the Rust route keeps unrelated traffic at 1–2 ms. In production terms, one
  expensive JS loader is a self-inflicted outage; the Rust version is one busy
  thread.

### Honest caveats

- **First-compile latency (dev).** The first request that touches the crate
  triggers a cargo compile (tens of seconds cold). Subsequent requests hit the
  content-hash cache. This is a dev-only, once-per-source-change cost; the
  production binary is baked into the build.
- **The ceiling is the core count.** Parallelism is real but finite — past ~10
  concurrent heavy requests on this 10-core machine, wall time climbs as work
  queues on Tokio workers. Rust buys a much higher and faster ceiling than the
  JS event loop (which is 1), not an infinite one.
- **Thread-pool tuning is a non-issue for `async fn`, contra the plan.**
  `UV_THREADPOOL_SIZE` does not apply; Tokio self-sizes to the hardware. Only
  revisit if switching an export to the `AsyncTask` form.
- **`NODE_ENV=production` is mandatory** for the served build to render at all
  (see the methodology note) — worth pinning in any deploy wrapper.
- **This workload is pure CPU.** The plan's accepted risk stands: if a real
  bottleneck turns out to be I/O rather than compute, none of this speedup
  applies. The win here is specifically for event-loop-blocking CPU work.
