// The showcase catalog: one entry per demo. The home page renders these as
// cards and each demo route can reuse its own entry for its heading. Demo
// agents own the route file behind `path`; this metadata is the contract the
// index relies on, so keep the shape stable.
export interface Demo {
  path: string;
  title: string;
  crate: string;
  blurb: string;
}

export const DEMOS: readonly Demo[] = [
  {
    path: "/search",
    title: "Full-text search",
    crate: "tantivy",
    blurb:
      "A real search engine (Rust's Lucene) as a library — a ranked, highlighted index over a bundled corpus, answering in sub-millisecond where minisearch/lunr fall over. A capability JS has no equivalent for.",
  },
  {
    path: "/images",
    title: "Image pipeline",
    crate: "image + ravif",
    blurb:
      "Buffer in, Buffer out: resize with SIMD and encode WebP/AVIF on real threads. AVIF encoding is CPU-brutal — you both see the output and feel the timing gap against pure-JS and wasm baselines.",
  },
  {
    path: "/transform",
    title: "HTML transform",
    crate: "lol_html + ammonia",
    blurb:
      "Untrusted HTML rewritten and sanitized in one streaming pass (no DOM build): UTM-tag links, inline CSS to style attributes, strip dangerous markup. The exact email-HTML workload that motivated this plugin.",
  },
  {
    path: "/hashing",
    title: "Password hashing",
    crate: "argon2",
    blurb:
      "Production-tuned Argon2id (~100ms by design), sync vs async side by side. Fire concurrent registrations and watch the sync path starve the event loop while the async one keeps serving.",
  },
] as const;
