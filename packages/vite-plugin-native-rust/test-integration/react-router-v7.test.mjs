// Integration: React Router v7 (framework mode), reusing the shipped example
// app unmodified. Drives the real `react-router` dev/build/serve CLIs over HTTP
// and asserts the Rust loader's output — the digest is recomputed in JS from
// the same seed/iteration count, so this is a genuine cross-implementation
// correctness check, not just a "renders" smoke test.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync as exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
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

const exampleDir = fileURLToPath(
  new URL("../../../examples/react-router", import.meta.url),
);
const node = process.execPath;
const rrBin = resolveBin(exampleDir, "@react-router/dev", "react-router");
const serveBin = resolveBin(exampleDir, "@react-router/serve", "react-router-serve");

// The example's default cache dir (rustPlugin() with no override). Cleared to
// force a cold compile without editing the shipped config.
const cacheDir = join(exampleDir, "node_modules", ".cache", "vite-rust");

// Mirror native/src/lib.rs::hash_chain in JS so we can assert the exact digest.
const ITERATIONS = 700_000;
function expectedDigest(iterations) {
  let buf = Buffer.from("vite-rust-import-plugin", "utf8");
  for (let i = 0; i < iterations; i++) buf = createHash("sha256").update(buf).digest();
  return buf.toString("hex");
}
const DIGEST = expectedDigest(ITERATIONS);

let hasCargo = true;
before(() => {
  try {
    exec("cargo", ["--version"], { stdio: "ignore" });
  } catch {
    hasCargo = false;
  }
});

function clearCache() {
  rmSync(cacheDir, { recursive: true, force: true });
}

const started = [];
after(async () => {
  for (const s of started) await s.kill();
});

test("dev: /rust loader returns the Rust-computed digest", async (t) => {
  if (!hasCargo) return t.skip("cargo not available");
  clearCache();
  const server = launch(node, [rrBin, "dev"], {
    cwd: exampleDir,
    env: { RR_NO_VERCEL: "1" },
  });
  started.push(server);
  await server.waitReady(/https?:\/\/localhost:\d+/);
  const base = server.output.match(/(https?:\/\/localhost:\d+)/)[1];

  const html = await fetchTextRetry(`${base}/rust`);
  assert.match(html, /add\(2, 3\) =\s*(?:<!--\s*-->)?\s*5/, "sync add export should render");
  assert.ok(html.includes(DIGEST), "async hashChain digest should match JS reference");
  assert.ok(compileCount(server.output) >= 1, "cold dev should compile the crate");
  await server.kill();
});

test("build + serve: shipped server emits one .node and returns the digest", async (t) => {
  if (!hasCargo) return t.skip("cargo not available");
  clearCache();

  const buildEnv = { RR_NO_VERCEL: "1" };
  const build1 = await run(node, [rrBin, "build"], { cwd: exampleDir, env: buildEnv });
  assert.equal(build1.code, 0, `build failed:\n${build1.output}`);
  assert.ok(compileCount(build1.output) >= 1, "cold build should compile");
  assert.equal(
    countNodeFilesRecursive(join(exampleDir, "build", "server")),
    1,
    "exactly one .node should ship in the server build",
  );

  // Run the built (standard node) server and hit /rust.
  const port = await getFreePort();
  const server = launch(node, [serveBin, join("build", "server", "index.js")], {
    cwd: exampleDir,
    env: { PORT: String(port) },
  });
  started.push(server);
  await server.waitReady(new RegExp(`${port}`));
  const html = await fetchTextRetry(`http://localhost:${port}/rust`);
  assert.ok(html.includes(DIGEST), "built server should return the Rust digest");
  assert.match(html, /add\(2, 3\) =\s*(?:<!--\s*-->)?\s*5/);
  await server.kill();

  // Second build with no source change compiles nothing (plugin cache hit).
  const build2 = await run(node, [rrBin, "build"], { cwd: exampleDir, env: buildEnv });
  assert.equal(build2.code, 0, `second build failed:\n${build2.output}`);
  assert.equal(compileCount(build2.output), 0, "warm build must not recompile");
});
