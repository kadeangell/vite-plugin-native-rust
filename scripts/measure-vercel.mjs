// Vercel production measurement harness. Node built-ins only.
// Mirrors MEASUREMENTS.md methodology over the public internet.
//
// Usage:
//   node scripts/measure-vercel.mjs single       # part 1: single-request latency
//   node scripts/measure-vercel.mjs concurrency   # part 2: N-concurrent A/B + scaling
//   node scripts/measure-vercel.mjs responsiveness# part 3: /api/hello probe under load
//   node scripts/measure-vercel.mjs cold          # part 4: single cold-start sample
//   node scripts/measure-vercel.mjs all           # 1-3 (not cold; run cold separately)

const BASE = process.env.BASE ?? "https://vite-rust-import-plugin.vercel.app";

const ROUTES = {
  hello: "/api/hello?q=x",
  rust: "/rust",
  slowCpu: "/slow-cpu",
  slowCpuRust: "/slow-cpu-rust",
};

const DIGEST_6M = "09537d1e2233662548a7d16a00b37bcb5b131b248f3d5fc6a5e3dd39dfcd7320";
const DIGEST_700K = "4107c82d1fa6864d261f6a5d3786d88f4814f6e1827718aee1ab096ec56b1fb3";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, d = 1) => Number(x.toFixed(d));

// One timed request. Returns latency (ms), status, x-vercel-id, and whether
// the body carried the expected digest (correctness gate).
async function timedGet(path, expectDigest) {
  const t0 = performance.now();
  let status = 0;
  let vercelId = "";
  let ok = null;
  try {
    const res = await fetch(BASE + path);
    status = res.status;
    vercelId = res.headers.get("x-vercel-id") ?? "";
    const body = await res.text(); // drain body -> full round trip
    if (expectDigest) ok = body.includes(expectDigest);
  } catch (e) {
    status = -1;
    ok = false;
    vercelId = `ERR:${e.code ?? e.name ?? "?"}`;
  }
  const ms = performance.now() - t0;
  return { ms, status, vercelId, ok };
}

async function warmup() {
  await Promise.all([
    timedGet(ROUTES.hello),
    timedGet(ROUTES.rust),
    timedGet(ROUTES.slowCpu),
    timedGet(ROUTES.slowCpuRust),
  ]);
}

async function single() {
  console.log(`# Single-request latency (${BASE})`);
  console.log("Warmup (one hit per route)...");
  await warmup();

  const specs = [
    ["JS   /slow-cpu     ", ROUTES.slowCpu, DIGEST_6M, 5],
    ["Rust /slow-cpu-rust", ROUTES.slowCpuRust, DIGEST_6M, 5],
    ["Rust /rust         ", ROUTES.rust, DIGEST_700K, 5],
    ["JSON /api/hello     ", ROUTES.hello, null, 5],
  ];
  for (const [label, path, digest, n] of specs) {
    const samples = [];
    let allOk = true;
    const ids = [];
    for (let i = 0; i < n; i++) {
      const r = await timedGet(path, digest);
      samples.push(r.ms);
      ids.push(r.vercelId);
      if (digest && r.ok === false) allOk = false;
      if (r.status !== 200) allOk = false;
      await sleep(300); // polite gap between sequential samples
    }
    const sorted = samples.map((x) => round(x)).sort((a, b) => a - b);
    console.log(
      `${label}  median=${round(median(samples))}ms  samples=[${sorted.join(", ")}]  digestOK=${allOk}`
    );
    console.log(`    x-vercel-id: ${ids.join(" | ")}`);
  }
}

async function concurrentBatch(path, n, digest) {
  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: n }, () => timedGet(path, digest))
  );
  const wall = performance.now() - t0;
  return { wall, results };
}

function reportBatch(label, n, wall, results) {
  const lat = results.map((r) => round(r.ms)).sort((a, b) => a - b);
  const statuses = results.map((r) => r.status);
  const okCount = results.filter((r) => r.ok !== false && r.status === 200).length;
  const ids = results.map((r) => r.vercelId);
  console.log(
    `${label}  N=${n}  wall=${round(wall)}ms  per-req=[${lat.join(", ")}]  ok=${okCount}/${n}  statuses=[${statuses.join(",")}]`
  );
  console.log(`    x-vercel-id: ${ids.join(" | ")}`);
}

async function concurrency() {
  console.log(`# Concurrency A/B (${BASE})`);
  await warmup();

  // Headline A/B at N=5
  {
    const { wall, results } = await concurrentBatch(ROUTES.slowCpu, 5, DIGEST_6M);
    reportBatch("JS   /slow-cpu     ", 5, wall, results);
  }
  await sleep(2000);
  {
    const { wall, results } = await concurrentBatch(ROUTES.slowCpuRust, 5, DIGEST_6M);
    reportBatch("Rust /slow-cpu-rust", 5, wall, results);
  }

  // Scaling curve for Rust: N=2, 5, 10
  console.log("\n## Rust scaling curve (/slow-cpu-rust)");
  for (const n of [2, 5, 10]) {
    await sleep(2000);
    const { wall, results } = await concurrentBatch(ROUTES.slowCpuRust, n, DIGEST_6M);
    reportBatch("Rust /slow-cpu-rust", n, wall, results);
  }
}

// Probe /api/hello every ~200ms for the duration of a concurrent load burst.
async function responsivenessDuring(loadPath, n, digest, label) {
  console.log(`\n## Probe /api/hello during N=${n} ${label}`);
  const probes = [];
  let probing = true;
  const probeLoop = (async () => {
    while (probing) {
      const r = await timedGet(ROUTES.hello);
      probes.push({ ms: r.ms, status: r.status });
      await sleep(200);
    }
  })();

  const { wall, results } = await concurrentBatch(loadPath, n, digest);
  probing = false;
  await probeLoop;

  reportBatch(`  load ${label}`, n, wall, results);
  const completed = probes.filter((p) => p.status === 200).map((p) => p.ms);
  if (completed.length) {
    const s = completed.map((x) => round(x)).sort((a, b) => a - b);
    console.log(
      `  probes completed=${completed.length}  min=${s[0]}ms  median=${round(median(completed))}ms  max=${s[s.length - 1]}ms`
    );
    console.log(`  probe samples: [${s.join(", ")}]`);
  } else {
    console.log(`  probes completed=0 (all probes starved/failed; ${probes.length} attempted)`);
  }
}

async function responsiveness() {
  console.log(`# Responsiveness under load (${BASE})`);
  await warmup();
  await responsivenessDuring(ROUTES.slowCpu, 5, DIGEST_6M, "JS /slow-cpu");
  await sleep(3000);
  await responsivenessDuring(ROUTES.slowCpuRust, 5, DIGEST_6M, "Rust /slow-cpu-rust");
}

async function cold() {
  console.log(`# Cold start single sample (${BASE})`);
  console.log("(run this ONLY after a deliberate idle period; no warmup)");
  const r = await timedGet(ROUTES.rust, DIGEST_700K);
  console.log(
    `/rust  latency=${round(r.ms)}ms  status=${r.status}  digestOK=${r.ok}  x-vercel-id=${r.vercelId}`
  );
  // Immediately follow with a warm hit for the delta.
  await sleep(500);
  const w = await timedGet(ROUTES.rust, DIGEST_700K);
  console.log(
    `/rust warm follow-up  latency=${round(w.ms)}ms  status=${w.status}  x-vercel-id=${w.vercelId}`
  );
}

const mode = process.argv[2] ?? "all";
const started = new Date().toISOString();
console.log(`# measure-vercel.mjs mode=${mode}  ${started}\n`);

if (mode === "single") await single();
else if (mode === "concurrency") await concurrency();
else if (mode === "responsiveness") await responsiveness();
else if (mode === "cold") await cold();
else if (mode === "all") {
  await single();
  console.log("\n" + "=".repeat(60) + "\n");
  await concurrency();
  console.log("\n" + "=".repeat(60) + "\n");
  await responsiveness();
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}
console.log(`\n# done ${new Date().toISOString()}`);
