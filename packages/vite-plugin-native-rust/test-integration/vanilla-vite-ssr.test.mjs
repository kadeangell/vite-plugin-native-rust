// Integration: bare Vite SSR (no framework). Exercises the full plugin
// contract end to end — dev compile + cache reuse, production build + run,
// build-time cache reuse, the client-leak guard, and two options spot-checks —
// against a real cargo toolchain. Sequential by design (cargo + shared crate).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import {
  compileCount,
  countNodeFilesRecursive,
  fetchText,
  freshCacheDir,
  getFreePort,
  launch,
  nodeFilesIn,
  removeDir,
  resolveBin,
  run,
} from "./helpers/harness.mjs";

const fixtureDir = fileURLToPath(
  new URL("./fixtures/vanilla-vite-ssr", import.meta.url),
);
const viteBin = resolveBin(fixtureDir, "vite");
const node = process.execPath;
const EXPECTED = "add=42;sumTo=5050";

// Skip the whole file (rather than fail) when the Rust toolchain is absent, so
// the suite degrades gracefully on machines without cargo.
let hasCargo = true;
before(() => {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
  } catch {
    hasCargo = false;
  }
});

const cacheDirs = [];
function scratchCache() {
  const dir = freshCacheDir("vanilla");
  cacheDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of cacheDirs) removeDir(dir);
});

async function startDev(cacheDir, { logLevel } = {}) {
  const port = await getFreePort();
  const server = launch(node, ["dev-server.mjs"], {
    cwd: fixtureDir,
    env: {
      PORT: String(port),
      RUST_CACHE_DIR: cacheDir,
      ...(logLevel ? { RUST_LOG_LEVEL: logLevel } : {}),
    },
  });
  await server.waitReady(/READY \d+/);
  return { server, port };
}

test("dev: cold request compiles once, then a fresh server reuses the cache", async (t) => {
  if (!hasCargo) return t.skip("cargo not available");
  const cacheDir = scratchCache();

  // Cold: first server compiles the crate exactly once.
  const cold = await startDev(cacheDir);
  try {
    const body = await fetchText(`http://127.0.0.1:${cold.port}/`);
    assert.equal(body, EXPECTED);
    assert.equal(compileCount(cold.server.output), 1, "expected one cold compile");
    assert.equal(
      nodeFilesIn(cacheDir).length,
      1,
      "custom cacheDir should hold exactly one .node",
    );
  } finally {
    await cold.server.kill();
  }

  // Warm: a brand-new server pointed at the same cache dir compiles nothing.
  const warm = await startDev(cacheDir);
  try {
    const body = await fetchText(`http://127.0.0.1:${warm.port}/`);
    assert.equal(body, EXPECTED);
    assert.equal(compileCount(warm.server.output), 0, "warm server must not recompile");
  } finally {
    await warm.server.kill();
  }
});

test("build: compiles once, output runs, second build is a cache hit", async (t) => {
  if (!hasCargo) return t.skip("cargo not available");
  const cacheDir = scratchCache();
  const env = { RUST_CACHE_DIR: cacheDir };

  const cold = await run(node, [viteBin, "build"], { cwd: fixtureDir, env });
  assert.equal(cold.code, 0, `cold build failed:\n${cold.output}`);
  assert.equal(compileCount(cold.output), 1, "expected one cold compile");
  assert.equal(
    countNodeFilesRecursive(join(fixtureDir, "dist")),
    1,
    "exactly one .node should ship in the build output",
  );

  // The shipped bundle (not the TS source) must produce the expected string.
  const built = await run(node, ["run-built.mjs"], { cwd: fixtureDir });
  assert.equal(built.code, 0, `running built output failed:\n${built.output}`);
  assert.equal(built.stdout.trim(), EXPECTED);

  const warm = await run(node, [viteBin, "build"], { cwd: fixtureDir, env });
  assert.equal(warm.code, 0, `warm build failed:\n${warm.output}`);
  assert.equal(compileCount(warm.output), 0, "warm build must not recompile");
});

test("client-leak: importing .rs from a client build fails with the server-side error", async (t) => {
  if (!hasCargo) return t.skip("cargo not available");
  const cacheDir = scratchCache();
  const leak = await run(
    node,
    [viteBin, "build", "--config", "vite.leak.config.ts"],
    { cwd: fixtureDir, env: { RUST_CACHE_DIR: cacheDir } },
  );
  assert.notEqual(leak.code, 0, "client build importing .rs must fail");
  assert.match(
    leak.output,
    /server-side/,
    "failure should carry the friendly server-side message",
  );
});

test("options: logLevel 'silent' suppresses the compile line but still compiles", async (t) => {
  if (!hasCargo) return t.skip("cargo not available");
  const cacheDir = scratchCache();
  const res = await run(node, [viteBin, "build"], {
    cwd: fixtureDir,
    env: { RUST_CACHE_DIR: cacheDir, RUST_LOG_LEVEL: "silent" },
  });
  assert.equal(res.code, 0, `silent build failed:\n${res.output}`);
  assert.equal(compileCount(res.output), 0, "silent must suppress the compile line");
  assert.equal(
    nodeFilesIn(cacheDir).length,
    1,
    "a real compile still happened (proves silence, not a cache hit)",
  );
});
