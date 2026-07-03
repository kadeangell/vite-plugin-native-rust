// Integration: React Router v8 (framework mode) on Vite 8's Environment API.
// This is the sharp-edge fixture — v8 moved to a rolldown-based Vite with the
// Environment API, so it proves the plugin's `options.ssr` load gate still
// fires for the SSR environment (server import compiles) and still rejects a
// client-reachable import (leak guard). The fixture is installed in isolation
// (its own node_modules) so it can run Vite 8 alongside the vite-6 example.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  compileCount,
  countNodeFilesRecursive,
  fetchTextRetry,
  getFreePort,
  launch,
  resolveBin,
  run,
} from "./helpers/harness.mjs";

const fixtureDir = fileURLToPath(
  new URL("./fixtures/react-router-v8", import.meta.url),
);
const node = process.execPath;
const EXPECTED = "add=42;sumTo=5050";
const cacheDir = join(fixtureDir, "node_modules", ".cache", "vite-rust");

// Skip the whole file when the fixture was never installed (its node_modules is
// isolated and set up by scripts/setup-fixtures.mjs) or cargo is missing.
const installed = existsSync(join(fixtureDir, "node_modules", "react-router"));
let hasCargo = true;
let rrBin;
let serveBin;
before(() => {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
  } catch {
    hasCargo = false;
  }
  if (installed) {
    rrBin = resolveBin(fixtureDir, "@react-router/dev", "react-router");
    serveBin = resolveBin(fixtureDir, "@react-router/serve", "react-router-serve");
  }
});

function ready() {
  return installed && hasCargo;
}
function clearCache() {
  rmSync(cacheDir, { recursive: true, force: true });
}

const started = [];
after(async () => {
  for (const s of started) await s.kill();
});

test("dev: /rust loader returns the Rust-computed output (ssr gate fires)", async (t) => {
  if (!ready()) return t.skip("fixture not installed or cargo missing");
  clearCache();
  const server = launch(node, [rrBin, "dev"], { cwd: fixtureDir });
  started.push(server);
  await server.waitReady(/https?:\/\/localhost:\d+/);
  const base = server.output.match(/(https?:\/\/localhost:\d+)/)[1];

  const html = await fetchTextRetry(`${base}/rust`);
  assert.ok(html.includes(EXPECTED), `expected "${EXPECTED}" in:\n${html}`);
  assert.ok(compileCount(server.output) >= 1, "cold dev should compile the crate");
  await server.kill();
});

test("build + serve: one .node ships, output runs, second build is a cache hit", async (t) => {
  if (!ready()) return t.skip("fixture not installed or cargo missing");
  clearCache();

  const build1 = await run(node, [rrBin, "build"], { cwd: fixtureDir });
  assert.equal(build1.code, 0, `build failed:\n${build1.output}`);
  assert.ok(compileCount(build1.output) >= 1, "cold build should compile");
  assert.equal(
    countNodeFilesRecursive(join(fixtureDir, "build", "server")),
    1,
    "exactly one .node should ship in the server build",
  );

  const port = await getFreePort();
  const server = launch(node, [serveBin, join("build", "server", "index.js")], {
    cwd: fixtureDir,
    env: { PORT: String(port) },
  });
  started.push(server);
  await server.waitReady(new RegExp(`${port}`));
  const html = await fetchTextRetry(`http://localhost:${port}/rust`);
  assert.ok(html.includes(EXPECTED), `built server should return "${EXPECTED}"`);
  await server.kill();

  const build2 = await run(node, [rrBin, "build"], { cwd: fixtureDir });
  assert.equal(build2.code, 0, `second build failed:\n${build2.output}`);
  assert.equal(compileCount(build2.output), 0, "warm build must not recompile");
});

test("client-leak: a client-reachable .rs import fails the build (server-side error)", async (t) => {
  if (!ready()) return t.skip("fixture not installed or cargo missing");
  const leak = await run(node, [rrBin, "build"], {
    cwd: fixtureDir,
    env: { RR_LEAK: "1" },
  });
  assert.notEqual(leak.code, 0, "leaking build must fail");
  assert.match(leak.output, /server-side/, "should carry the friendly server-side error");
});
