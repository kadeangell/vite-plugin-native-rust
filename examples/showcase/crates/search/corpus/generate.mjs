#!/usr/bin/env node
// Deterministic generator for the showcase search corpus (corpus.jsonl).
//
// Provenance: the corpus is 100% synthetic — every document is produced by
// this script from the vocabulary below using a fixed-seed PRNG, so the
// committed corpus.jsonl is reproducible byte-for-byte and carries no
// third-party data or license. It is covered by this repository's MIT license.
//
// Regenerate:  node generate.mjs   (writes corpus.jsonl next to this file)
//
// Design: ~10k short "tech encyclopedia" micro-articles built from combinable
// subjects/aspects so realistic multi-term queries ("rust memory safety",
// "postgres query planning") return meaningfully ranked results instead of
// random-noise matches. Kept under ~2 MB so the repo stays lean; the Rust
// crate embeds the file via include_str! and the JS baseline imports the same
// bytes via Vite's ?raw, guaranteeing both engines index an identical corpus.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEED = 0xc0ffee;
const DOC_COUNT = 10_000;

// mulberry32 — tiny deterministic PRNG, plenty for corpus generation.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS = [
  "Rust", "TypeScript", "JavaScript", "Python", "Go", "Zig", "C++", "Java",
  "Kotlin", "Swift", "Erlang", "Elixir", "Haskell", "OCaml", "WebAssembly",
  "Node.js", "Deno", "Bun", "V8", "SpiderMonkey", "tantivy", "Lucene",
  "Elasticsearch", "Meilisearch", "PostgreSQL", "SQLite", "MySQL", "Redis",
  "RocksDB", "LevelDB", "DuckDB", "ClickHouse", "Kafka", "RabbitMQ", "NATS",
  "gRPC", "GraphQL", "React", "Vue", "Svelte", "Solid", "Vite", "Rollup",
  "esbuild", "webpack", "Turbopack", "rolldown", "napi-rs", "Neon", "wasmtime",
  "Tokio", "rayon", "serde", "hyper", "axum", "actix", "Nginx", "Envoy",
  "HAProxy", "Docker", "Kubernetes", "systemd", "Linux", "FreeBSD", "QUIC",
  "HTTP/3", "TLS 1.3", "BoringSSL", "OpenSSL", "libuv", "io_uring", "eBPF",
];

const ASPECTS = [
  "memory safety", "garbage collection", "borrow checking", "data races",
  "query planning", "query optimization", "full-text search", "inverted indexes",
  "faceted search", "relevance ranking", "BM25 scoring", "tokenization",
  "stemming", "fuzzy matching", "typo tolerance", "snippet highlighting",
  "index compaction", "segment merging", "write amplification", "compression",
  "zero-copy parsing", "streaming parsing", "HTML sanitization", "input validation",
  "error handling", "backpressure", "connection pooling", "load shedding",
  "event loop latency", "thread pool sizing", "work stealing", "lock contention",
  "cache locality", "SIMD acceleration", "vectorized execution", "branch prediction",
  "tail latency", "p99 latency", "throughput tuning", "batching",
  "content hashing", "incremental compilation", "build caching", "tree shaking",
  "code splitting", "hot module replacement", "server-side rendering", "hydration",
  "schema migrations", "replication lag", "consensus protocols", "leader election",
  "rate limiting", "circuit breaking", "observability", "distributed tracing",
  "structured logging", "flame graphs", "heap profiling", "fault injection",
  "property-based testing", "fuzzing", "sandboxing", "privilege separation",
];

const CONTEXTS = [
  "in production", "at scale", "on serverless platforms", "under sustained load",
  "in CI pipelines", "on commodity hardware", "in embedded targets",
  "for real-time systems", "in multi-tenant clusters", "behind a CDN",
  "during traffic spikes", "in air-gapped deployments", "on ARM servers",
  "with strict latency budgets", "for batch workloads", "in edge runtimes",
  "under memory pressure", "across availability zones", "in monorepos",
  "for greenfield services", "in legacy migrations", "with zero downtime",
  "on spot instances", "for high-cardinality data",
];

const TECHNIQUES = [
  "amortizing allocations across requests", "precomputing lookup tables",
  "pinning hot data in cache", "batching writes into a single fsync",
  "sharding by tenant", "deferring work to background threads",
  "trading memory for latency", "using lock-free ring buffers",
  "compacting segments off-peak", "profiling before optimizing",
  "isolating noisy neighbors", "checkpointing incremental state",
  "streaming instead of buffering", "validating inputs at the boundary",
  "reusing connections aggressively", "hedging slow requests",
  "collapsing duplicate queries", "warming caches at deploy time",
  "bounding queues explicitly", "sampling traces adaptively",
  "encoding invariants in types", "failing fast on malformed input",
  "measuring allocations per request", "pipelining independent stages",
];

const OUTCOMES = [
  "a measurable drop in p99 latency", "fewer pages at 3 a.m.",
  "double-digit throughput gains", "a smaller steady-state heap",
  "predictable tail behavior", "cleaner error budgets",
  "faster cold starts", "simpler capacity planning",
  "fewer cross-team escalations", "a flatter latency histogram",
  "lower egress costs", "shorter incident reviews",
  "reproducible benchmarks", "less time firefighting regressions",
  "smoother deploys", "tighter feedback loops",
  "fewer flaky tests", "an order-of-magnitude smaller index",
  "less lock contention under load", "safer refactors",
];

const GERUNDS = [
  "Debugging", "Benchmarking", "Rethinking", "Scaling", "Migrating",
  "Instrumenting", "Hardening", "Profiling", "Taming", "Demystifying",
  "Revisiting", "Shipping",
];

const TITLE_TEMPLATES = [
  (r, s, a, c) => `${s} ${a} ${c}`,
  (r, s, a, c) => `${pick(r, GERUNDS)} ${a} with ${s}`,
  (r, s, a, c) => `How ${s} handles ${a} ${c}`,
  (r, s, a, c) => `${a} in ${s}: notes from the field`,
  (r, s, a, c) => `A practical guide to ${a} in ${s}`,
  (r, s, a, c) => `Why ${a} matters for ${s} ${c}`,
];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Doc ids are implicit: a document's id is its zero-based line number, which
// both the Rust indexer and the JS baseline derive identically at parse time.
function makeDoc(rng) {
  const subject = pick(rng, SUBJECTS);
  const aspect = pick(rng, ASPECTS);
  const context = pick(rng, CONTEXTS);
  const title = pick(rng, TITLE_TEMPLATES)(rng, subject, aspect, context);

  const technique = pick(rng, TECHNIQUES);
  const outcome = pick(rng, OUTCOMES);
  const aspect2 = pick(rng, ASPECTS);
  const subject2 = pick(rng, SUBJECTS);
  const body =
    `${subject} handles ${aspect} by ${technique}. ` +
    `With ${subject2} for ${aspect2}, teams report ${outcome}.`;

  return { title, body };
}

const rng = mulberry32(SEED);
const lines = [];
for (let i = 0; i < DOC_COUNT; i++) {
  lines.push(JSON.stringify(makeDoc(rng)));
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), "corpus.jsonl");
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

const bytes = lines.reduce((sum, l) => sum + l.length + 1, 0);
console.log(
  `wrote ${DOC_COUNT} docs (${(bytes / 1024 / 1024).toFixed(2)} MB) to ${outPath}`,
);
