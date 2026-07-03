# When not to use this

This plugin is worth its build-time cost (a Rust toolchain, longer builds,
compiled binaries) only for a specific shape of problem: **CPU-bound work in a
server loader**. Here are the cases where it buys you little or nothing, so you
can decide honestly before adopting it.

## Your loader is I/O-bound, not CPU-bound

If a server function spends its time waiting on a database, an HTTP call, a file
read, or any other I/O, moving it to Rust changes almost nothing. The bottleneck
is the wait, not the compute, and Node already handles I/O concurrency well —
async I/O doesn't block the event loop the way a synchronous CPU loop does.

The measured wins (~2.9× local, ~7× on Vercel) are for a pure-CPU SHA-256 hash
chain. That is the plan's standing, accepted risk, stated plainly: if you profile
and find your slow loaders are I/O all along, none of this speedup applies. **Profile
first.** Reach for Rust only when the flame graph shows CPU.

## WASM would be simpler and you don't need what native gives you

If you want to run some Rust in a server function but don't need real OS threads,
raw native performance, or access to the full native ecosystem, **WebAssembly is
the simpler tool**. WASM has no `dlopen`, no per-platform binary, no build-on-
target step, and platform-independent artifacts. Use `wasm-pack` +
`vite-plugin-wasm` and skip this plugin entirely.

This plugin exists specifically for the cases WASM makes awkward:

- **True multithreading.** WASM threads in Node need `SharedArrayBuffer` plus
  worker gymnastics, and `wasm-bindgen-rayon` is browser-oriented. Native
  `#[napi] async fn` runs on real threads (napi-rs's Tokio pool) with a plain
  `await` on the JS side. Parallelism is the whole reason to pick native.
- **Maximum single-thread performance.** Native code avoids WASM's overhead.
- **OS / system access** and native crates that assume a real platform.

If none of those three apply, prefer WASM. It's less machinery for the same
result.

## You're deploying to serverless *for the availability argument*

Locally, Rust's biggest win is availability: a synchronous JS loader jams the one
event loop and starves every other request, while the Rust version costs one
thread. That argument **does not transfer to serverless**. Platforms like Vercel
Fluid fan concurrent requests out to separate instances, so a blocking JS request
never starves an unrelated one — the platform already provides the isolation.

On serverless, Rust is still a clear win for **latency and cost** (~7× each in the
measurements), but if availability under load was your *only* reason to adopt it
and you're deploying to a fan-out serverless platform, that specific reason is
already handled for you. Adopt for the latency/cost win, not the availability one.
See [benchmarks.md](benchmarks.md#vercel-serverless).

## You're targeting an edge runtime

**Edge runtimes are never supported.** Cloudflare Workers, Vercel Edge, Deno
Deploy and similar V8-isolate environments cannot `dlopen` a native `.node`
addon at all. This plugin produces native binaries for Node's Node.js runtime
only. On Vercel that means the **Node.js** function runtime, not the Edge runtime.
If your route must run at the edge, this plugin cannot help it — use WASM, which
edge runtimes can execute.

## You're on Windows (for now)

Windows is not yet supported. macOS and Linux are the verified targets. If Windows
is your dev or deploy platform, this plugin isn't ready for you yet — track the
Windows issue for progress.

## A note on the dev-loop memory leak

Not a reason to avoid the plugin, but worth knowing: in **dev**, each Rust edit
produces a new content-hashed `.node` that the dev server `dlopen`s, and the old
handles can't be cleanly unloaded, so they accumulate in the dev-server process.
It's bounded by your edit count and cleared by a restart. Production loads exactly
one addon and is unaffected. If you edit Rust constantly across very long dev
sessions, keep this in the back of your mind — but it doesn't change the adopt/
don't-adopt decision.
