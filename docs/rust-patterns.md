# Rust patterns for plugin users

Distilled from building the [showcase demos](../examples/showcase) — four real
crates.io integrations, each pattern linked to working code you can copy.

## Async vs sync exports (and why it's the whole point)

A plain `#[napi] fn` runs on Node's **main thread**. If it takes 60 ms, then
four concurrent calls are one continuous 240 ms stall during which timers, I/O,
and every other request run *nothing* — not "late," nothing. An
`#[napi] async fn` with the same body runs on napi-rs's worker pool (Tokio,
self-sized to your cores): four calls take ~1× wall time and the event loop
stays at sub-millisecond lag.

Measured in [`crates/hashing`](../examples/showcase/crates/hashing) (Argon2id,
~62 ms/hash, 4 concurrent calls): sync export — 250 ms wall, loop blocked
245 ms straight; async export — 93 ms wall, max loop lag 0.8 ms.

**Rule: if it takes more than ~1 ms, export it `async`.** The sync form is for
cheap glue only — and it cuts both ways: a warm 0.1 ms read (see the search
pattern below) should NOT pay a thread-pool round trip just to be fashionable.

## Result errors → catchable JS exceptions

Return `napi::Result<T>`; an `Err(Error::new(Status::InvalidArg, msg))`
becomes a rejected Promise carrying your message — ordinary `try/catch` on the
JS side, no panics, no process crashes. Reserve `Err` for exceptional states
(corrupt stored hash, undecodable image) and encode *expected* negatives in
the type instead (`Ok(false)` for "wrong password").

## Buffers and options objects

The bread-and-butter surface: raw bytes in, raw bytes out, with a typed options
bag. Take `Buffer` as a parameter (arrives zero-ceremony from any Node
`Buffer`); return one by converting a `Vec<u8>` with `.into()`. Group knobs
into a `#[napi(object)]` struct — it maps to a plain JS object literal, so the
call site reads `await thumbnail(buf, { width: 480, format: "webp" })`. Two
refinements worth copying from
[`crates/images`](../examples/showcase/crates/images):

1. Narrow stringly-typed fields in the generated TS with
   `#[napi(ts_type = "\"webp\" | \"avif\"")]`, backed by runtime validation
   returning `Status::InvalidArg` — TS users get a compile-time union, JS users
   get a clear exception instead of a deep encoder panic.
2. Return a `#[napi(object)]` result struct carrying the payload `Buffer` plus
   metadata (dimensions, per-phase `Instant` timings). Fields are snake_case
   in Rust and arrive camelCase in JS; doc comments carry into the `.d.rs.ts`.

Rayon-using crates compose transparently: the async fn runs on the worker
pool, and rayon fans out across cores from there.

## Stateful native libraries

Long-lived Rust state — a search index, a connection pool, a compiled
grammar — lives in a process-wide static:

```rust
static SERVICE: OnceLock<Result<SearchService, String>> = OnceLock::new();
```

`get_or_init` gives exactly-once construction under concurrent first calls,
and caching the *error* string means a broken init fails every call loudly
instead of retrying a doomed build per request. The addon loads once per Node
process, so a Rust static has request-scoped-singleton semantics with zero JS
wiring.

Split the API: an **async warmup** (`ensureIndex()` — real work, off the
loop, doubles as the stats endpoint) and a **sync hot path** (`search()` —
~0.1 ms warm, below a thread-pool round trip). Document that callers hit the
warmup first; a lazily-initializing sync fn would do the heavy build ON the
event loop. Working code:
[`crates/search`](../examples/showcase/crates/search) (tantivy).

`include_str!` completes the pattern: embed data in the binary and the
deployed addon is self-contained — no runtime file paths, serverless-friendly
— at the cost of binary size and a recompile on data changes.

## Composing multiple crates in one export

[`crates/transform`](../examples/showcase/crates/transform) runs one
`lol_html` streaming pass then `ammonia` sanitization behind a single
`transformHtml(html, opts)`. Lessons: prefer one options struct over N
positional args; measure per-stage with `Instant` *inside* the fn so timings
exclude the napi boundary; and beware DOM-normalizing crates (html5ever
inserts missing `<tbody>`) when diffing rewriter output — count what you
removed by tag, not by total node count.

## Debug builds lie about performance

The plugin compiles **debug** in dev (fast rebuilds) and **release** for
`vite build`. Optimized Rust is routinely 10–30× its debug self, so a
benchmark or perf-sensitive demo viewed on the dev server can show Rust
*losing* to JavaScript it beats 5× in production (measured: debug AVIF encode
2,032 ms vs release 26.7 ms; debug lol_html lost to cheerio).

Fixes, pick one:

- `rustPlugin({ profile: "release" })` — right for benchmark/showcase apps;
  costs slower dev rebuilds ([the showcase does this](../examples/showcase/vite.config.ts)).
- In the crate, optimize dependencies only — your own glue still compiles
  instantly:

  ```toml
  [profile.dev.package."*"]
  opt-level = 3
  ```

Either way: never quote dev-server numbers.

## Compile time and binary size (real data)

Measured cold `cargo build --release` per showcase crate (Apple Silicon; the
plugin's content-hash cache makes every subsequent build instant):

| crate | deps | cold compile | addon size |
| --- | --- | --- | --- |
| hashing (argon2) | 46 | 11 s | 574 KB |
| transform (lol_html + ammonia) | 107 | 25 s | 2.0 MB |
| search (tantivy + 2 MB corpus) | 156 | 42 s | 6.9 MB |
| images (image + fast_image_resize + ravif) | 128 | 64 s | 2.6 MB |

Nowhere near serverless limits (Vercel: 250 MB unzipped), and commit your
`Cargo.lock` — a lockfile created mid-build changes the cache key and forces a
pointless second compile (issue #4).
