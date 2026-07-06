// Integration: vitest 4 (rolldown-vite) on Vite 8 importing a Rust crate.
// Guards issue #2 — vitest parses `.rs` imports as JS at collection time unless
// the plugin sits in vitest's own pipeline. Two paths, one fixture:
//   - "native" project: rustPlugin() in the vitest config, jsdom environment
//     (ssr=false) — proves the client-graph gate bypass and the dev-shape
//     loader. Its tests assert the REAL Rust values (add=42, sumTo=5050).
//   - "stub" project: rustTestStub redirects the same `.rs` import to a JS twin
//     (sumTo=0 sentinel) — proves the no-toolchain path.
// vitest reports `this.meta.watchMode === false` under BOTH `vitest run` and
// `vitest --watch`, so the plugin can't rely on watchMode to pick the dev
// shape here — it keys off vitest detection instead. This suite drives the
// risky `vitest run` (non-watch) path.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { resolveBin, run } from "./helpers/harness.mjs";

const fixtureDir = fileURLToPath(
  new URL("./fixtures/vitest-consumer", import.meta.url),
);
const node = process.execPath;
const cacheDir = join(fixtureDir, "node_modules", ".cache", "vite-rust");

const installed = existsSync(join(fixtureDir, "node_modules", "vitest"));
let hasCargo = true;
let vitestBin;
before(() => {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
  } catch {
    hasCargo = false;
  }
  if (installed) vitestBin = resolveBin(fixtureDir, "vitest");
});

function clearCache() {
  rmSync(cacheDir, { recursive: true, force: true });
}

test("vitest run: native (rustPlugin) + stub (rustTestStub) projects both pass", async (t) => {
  if (!installed || !hasCargo) return t.skip("fixture not installed or cargo missing");
  // Cold cache so the native project genuinely compiles the crate this run.
  clearCache();
  const res = await run(node, [vitestBin, "run"], { cwd: fixtureDir });
  assert.equal(res.code, 0, `vitest run failed:\n${res.output}`);
  // Both projects, all six tests: the native project's 5050 assertion only
  // passes against the real compiled crate; the stub project's sentinel (0)
  // assertion only passes when the twin replaced the `.rs`.
  assert.match(res.output, /6 passed/, `expected 6 passing tests:\n${res.output}`);
  assert.doesNotMatch(res.output, /\bfailed\b/, `no test should fail:\n${res.output}`);
});

test("vitest run --project stub: the JS-twin path stands alone (no compile)", async (t) => {
  if (!installed) return t.skip("fixture not installed");
  // The stub project never touches cargo — this is the CI-without-a-toolchain
  // story. Runs regardless of whether cargo is present.
  const res = await run(node, [vitestBin, "run", "--project", "stub"], {
    cwd: fixtureDir,
  });
  assert.equal(res.code, 0, `stub-only run failed:\n${res.output}`);
  assert.match(res.output, /3 passed/, `expected the 3 stub tests to pass:\n${res.output}`);
});

after(() => {
  /* no long-lived processes to tear down */
});
