# Plan: showcase demos with real Rust crates

## Goal

Replace "look, it adds numbers" with demos where the Rust crate ecosystem does
something the JS ecosystem genuinely can't (or does 10–100× slower), each one a
realistic server-side task a Vite app would actually ship. One new
`examples/showcase` app (RRv7 — the flagship framework), one route per demo,
each route rendering a live A/B against the best JS baseline, deployed to
Vercel as `vpnr-showcase`.

The pitch each demo must make: *this is a real crates.io dependency, imported
into a loader with one line, and here is the measured gap.*

## Why a dedicated showcase app (not more routes in framework examples)

Framework examples answer "does the plugin work on X" — they should stay
minimal (add/sumTo is fine THERE). The showcase answers "why would I want
this," and it needs room: real datasets, live benchmark tables, image output.
One app keeps the heavyweight crate compile times out of the framework
examples' CI lanes.

## The four demos

### 1. Full-text search — `tantivy` (the capability gap)

The one JS fundamentally cannot match: a real search engine (Rust's Lucene) as
a library. At startup, index a bundled corpus (~10–50k docs — e.g. a public
dataset of HN titles or MDN docs); a `/search?q=` loader serves ranked,
highlighted results.

- **Why compelling:** minisearch/lunr fall over at this scale; tantivy answers
  in sub-millisecond. No JS equivalent exists — this isn't a speedup, it's a
  capability.
- **napi surface exercised (new for us):** *stateful* native lib — the index
  and reader live in Rust statics (`OnceLock`) across requests, not a pure
  function. Struct returns (hits: title/score/snippet as `#[napi(object)]`).
- **A/B:** same corpus in minisearch, same queries, p50/p99 + index-build time.
- **Risk:** index build on cold start (mitigate: build at module init, measure
  and show it honestly; or pre-build the index into a committed artifact).

### 2. Image pipeline — `image` + `fast_image_resize` + `webp`/`ravif` (the visceral one)

`/thumbnail` endpoint: accepts an image upload (or bundled samples), resizes
with SIMD (`fast_image_resize`), encodes WebP/AVIF, returns the image. AVIF
encoding is famously CPU-brutal — rayon inside the async fn shows multi-core
per-request.

- **Why compelling:** you SEE the output; AVIF-encode timing differences are
  dramatic; Buffer-in/Buffer-out is the bread-and-butter napi surface every
  real user asks about first.
- **napi surface:** `Buffer` both directions, options object, rayon.
- **A/B:** honest three-way — pure-JS (`jimp`), wasm (`@jsquash/avif`), and a
  note on `sharp` (also native — the comparison there is "same class of
  performance, but you can customize the pipeline in Rust instead of being
  limited to libvips' API").
- **Risk:** `ravif` compile time (~1–2 min). Acceptable; the cache eats it
  after first build.

### 3. HTML transform + sanitize — `lol_html` + `ammonia` (the Zaymo-shaped one)

A `/transform` endpoint that takes untrusted HTML and, in one streaming pass
(Cloudflare's `lol_html` rewriter): rewrites links (UTM tagging), inlines CSS
classes to style attributes (the email classic), strips dangerous
markup (`ammonia` sanitize). This is a real production shape — it is
approximately what an email-HTML transformer does all day.

- **Why compelling:** streaming rewriter architecture (no DOM build) vs
  cheerio's parse-modify-serialize; sanitization is security-real; and it
  demos the plugin on the exact workload class that motivated the project.
- **napi surface:** string/Buffer in-out, callback-free config structs; shows
  a nontrivial third-party C-backed crate (`lol_html`) building cleanly under
  napi.
- **A/B:** cheerio + sanitize-html doing the same three transforms; MB/s and
  p50 on a corpus of real-world email HTML (bundle a few CC0 samples).

### 4. Password hashing — `argon2` (the "why async matters" one, small)

`/register`-style endpoint hashing with production-tuned Argon2id params
(~100ms by design). Two implementations side by side: sync JS argon2 (or
deliberately-sync Rust via a `#[napi]` non-async fn) vs the async Rust form.
Fire concurrent registrations, watch the probe endpoint: the sync version
starves the event loop, the async one doesn't — the MEASUREMENTS.md story
retold with a workload every backend developer recognizes as real.

- **Why compelling:** deliberately-slow crypto is the cleanest possible
  motivation for "off the event loop"; tiny crate, fast compile, ~20 lines of
  Rust.
- **napi surface:** the async-by-convention contract, error propagation
  (wrong-password verify path returns a Result error → JS exception).
- **A/B:** built into the demo itself (sync vs async is the demo).

## Cross-cutting work these force (the real payoff for the plugin)

1. **Richer napi type surface in the docs** — Buffer, `#[napi(object)]`
   structs, Result errors, stateful statics. Today's docs only show
   number/string fns. Each demo contributes a documented pattern to a new
   `docs/rust-patterns.md`.
2. **Compile-time honesty** — tantivy/ravif push cold compiles to minutes.
   Document real numbers per demo; verify the cache + Vercel warm-build story
   holds at this scale (`cargo-target` cache dir size limits on Vercel?).
3. **Binary size** — these crates will produce multi-MB addons. Measure,
   document, confirm Vercel function limits are nowhere close (250MB).
4. **create-native-rust roadmap input** — if the demos reveal a repeated
   setup shape (features, profile tweaks, rayon), consider a `--template`
   flag later. Not in this scope.

## Build order

0. Scaffold `examples/showcase` (RRv7 app, one crate per demo? NO — one
   workspace crate with feature-gated modules would tangle the cache story;
   **one crate per demo** under `examples/showcase/crates/<demo>/`, each an
   independent import site, proving multi-crate support in one app for free).
1. Demo 4 (argon2) first — smallest, proves the multi-crate scaffold.
2. Demo 3 (lol_html/ammonia) — highest personal relevance.
3. Demo 1 (tantivy) — the headline; needs the stateful-lib pattern worked out.
4. Demo 2 (image/AVIF) — most polish (file upload UI, image rendering).
5. Benchmark page aggregating all four A/Bs + a docs/rust-patterns.md distilled
   from what the demos taught; README "Showcase" section linking the deployed
   app.
6. Deploy `vpnr-showcase` to Vercel, validate every route + the A/B numbers.

Parallelizable: after step 0 lands, demos 1–4 are independent (separate crates,
separate routes) — four worktree agents, same loop as the framework examples.

## Out of scope

- `polars`/DataFrame analytics demo — the most impressive candidate on paper,
  but a 5–10 min cold compile makes every CI lane and Vercel build miserable;
  revisit only with a prebuilt-artifact story.
- Typst/PDF generation — great demo, heavyweight dep tree; candidate for a
  wave 2.
- Publishing any of the demo crates to crates.io/npm.
- create-native-rust template work (roadmap note only).
