// Integration: React Router v7 on Vite 8 with @vercel/react-router's
// vercelPreset() — the exact stack from issue #1. The preset splits the server
// build into per-function bundles under build/server/nodejs_<base64url(config)>/
// (one default bundle + one for the route carrying `export const config`), and
// BOTH bundles import the native crate. The bug: the emitted `.node` asset was
// dropped from that layout, and the generated loader required it at module top
// level — an uncatchable cold-start crash.
//
// This fixture proves the fix: (1) the addon survives next to every chunk that
// references it, (2) each built function bundle loads the addon end-to-end when
// its route loader runs, and (3) importing a bundle does not crash at init
// (the loader is lazy), so a missing binary would be a catchable per-call error.
// Installed in isolation (its own node_modules) so it can run Vite 8.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { compileCount, resolveBin, run } from "./helpers/harness.mjs";

const fixtureDir = fileURLToPath(
  new URL("./fixtures/react-router-v7-vercel-preset", import.meta.url),
);
const node = process.execPath;
const serverDir = join(fixtureDir, "build", "server");
const cacheDir = join(fixtureDir, "node_modules", ".cache", "vite-rust");

const installed = existsSync(
  join(fixtureDir, "node_modules", "@vercel", "react-router"),
);
let hasCargo = true;
let rrBin;
before(() => {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
  } catch {
    hasCargo = false;
  }
  if (installed) {
    rrBin = resolveBin(fixtureDir, "@react-router/dev", "react-router");
  }
});

function ready() {
  return installed && hasCargo;
}
function clearCache() {
  execFileSync("rm", ["-rf", cacheDir]);
}

// Absolute paths of the per-function bundle entry chunks (build/server/*/index.js)
// whose code references the given addon fileName.
function bundlesReferencing(addonFileName) {
  return readdirSync(serverDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(serverDir, e.name, "index.js"))
    .filter(
      (p) => existsSync(p) && readFileSync(p, "utf8").includes(addonFileName),
    );
}

// The single addon fileName the plugin emitted (all bundles share it — same
// source → same content hash).
function emittedAddonFileName() {
  for (const e of readdirSync(serverDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const node = readdirSync(join(serverDir, e.name)).find((f) =>
      f.endsWith(".node"),
    );
    if (node) return node;
  }
  return null;
}

// Expected Rust-computed loader output per route id (add/sumTo done in Rust).
const EXPECTED = {
  "routes/rust": { sum: 42, total: 5050 },
  "routes/rust-slow": { sum: 3, total: 20100 },
};

// Drive the real built server module: import the bundle chunk and run every
// rust route's loader. Returns a map of routeId → loader result. Importing the
// module must NOT throw (proves the loader is lazy, not a top-level require).
async function runRustLoaders(bundleIndexJs) {
  const mod = await import(pathToFileURL(bundleIndexJs).href);
  const results = {};
  for (const [id, route] of Object.entries(mod.routes ?? {})) {
    const loader = route?.module?.loader;
    if (typeof loader === "function" && id.includes("rust")) {
      results[id] = await loader({
        request: new Request("http://localhost/"),
        params: {},
        context: {},
      });
    }
  }
  return results;
}

test("build: the emitted addon survives next to every chunk that references it", async (t) => {
  if (!ready()) return t.skip("fixture not installed or cargo missing");
  clearCache();

  const build = await run(node, [rrBin, "build"], { cwd: fixtureDir });
  assert.equal(build.code, 0, `build failed:\n${build.output}`);
  assert.ok(compileCount(build.output) >= 1, "cold build should compile the crate");

  const addon = emittedAddonFileName();
  assert.ok(addon, "the plugin should emit a .node asset into the server build");

  // The preset must have produced the two-function layout from the issue: the
  // default bundle and the maxDuration bundle, both importing the crate.
  const referencing = bundlesReferencing(addon);
  assert.ok(
    referencing.length >= 2,
    `expected >=2 per-function bundles referencing the addon, got ${referencing.length}`,
  );

  // The core guarantee: for every chunk that references the addon, the file
  // exists as a sibling (where `new URL("<addon>", import.meta.url)` resolves).
  for (const indexJs of referencing) {
    const sibling = join(dirname(indexJs), addon);
    assert.ok(
      existsSync(sibling),
      `addon missing next to referencing chunk: ${sibling}`,
    );
  }
});

test("run: each built function bundle loads the addon end-to-end (lazy init)", async (t) => {
  if (!ready()) return t.skip("fixture not installed or cargo missing");
  // Reuse the build from the previous test if present; otherwise build now.
  if (!existsSync(serverDir)) {
    const build = await run(node, [rrBin, "build"], { cwd: fixtureDir });
    assert.equal(build.code, 0, `build failed:\n${build.output}`);
  }

  const addon = emittedAddonFileName();
  const referencing = bundlesReferencing(addon);
  assert.ok(referencing.length >= 2, "expected the two-function layout");

  let drove = 0;
  for (const indexJs of referencing) {
    // Importing the bundle must not throw — the addon is loaded lazily on the
    // first loader call, not at module init (the fix for the cold-start crash).
    const results = await runRustLoaders(indexJs);
    for (const [id, actual] of Object.entries(results)) {
      assert.deepEqual(
        actual,
        EXPECTED[id],
        `built loader ${id} returned unexpected Rust output`,
      );
      drove += 1;
    }
  }
  assert.ok(drove >= 2, `expected to drive >=2 rust loaders, drove ${drove}`);
});

test("build: the generated loader is lazy (no top-level addon require)", async (t) => {
  if (!ready()) return t.skip("fixture not installed or cargo missing");
  if (!existsSync(serverDir)) {
    const build = await run(node, [rrBin, "build"], { cwd: fixtureDir });
    assert.equal(build.code, 0, `build failed:\n${build.output}`);
  }

  const addon = emittedAddonFileName();
  for (const indexJs of bundlesReferencing(addon)) {
    const code = readFileSync(indexJs, "utf8");
    // The loader require lives inside a function body, gated by `__vrLoad`.
    assert.match(code, /function __vrLoad\(\)/, "should emit the lazy loader");
    // No eager top-level require of the addon path: the only require of the
    // addon is inside __vrLoad. `__vrLoad()` must only appear in call-site
    // wrappers (arrow bodies), never as a bare top-level statement.
    assert.doesNotMatch(
      code,
      /^\s*(?:var|const|let)\s+__vrAddon\s*=\s*require\(/m,
      "addon must not be required eagerly at module top level",
    );
  }
});

test("build: a second build with no source change is a plugin cache hit", async (t) => {
  if (!ready()) return t.skip("fixture not installed or cargo missing");
  const build2 = await run(node, [rrBin, "build"], { cwd: fixtureDir });
  assert.equal(build2.code, 0, `second build failed:\n${build2.output}`);
  assert.equal(compileCount(build2.output), 0, "warm build must not recompile");
});

after(() => {});
