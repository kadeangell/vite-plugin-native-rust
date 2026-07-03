import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { scaffold } from "../lib/scaffold.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// Resolve the napi CLI from this repo's node_modules (the temp crate lives in
// os.tmpdir(), where `npx napi` could not find it and might try to download).
function napiCliPath() {
  const pkgJson = require.resolve("@napi-rs/cli/package.json");
  return join(dirname(pkgJson), "dist", "cli.js");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// One real end-to-end build. Gated behind a toolchain probe: if cargo/rustc are
// missing (e.g. a JS-only CI lane) the test skips rather than failing spuriously.
// A generous timeout covers a cold cargo compile.
test("scaffolded crate builds with napi and exposes its sample exports", { timeout: 300_000 }, async (t) => {
  try {
    await execFileAsync("cargo", ["--version"]);
    await execFileAsync("rustc", ["--version"]);
  } catch {
    t.skip("cargo/rustc not available — skipping real build");
    return;
  }

  const base = await mkdtemp(join(tmpdir(), "create-native-rust-e2e-"));
  try {
    const target = join(base, "demo");
    const { name } = await scaffold({ dir: target, name: "demo" });

    // Real napi build (release, so we exercise the shipped profile).
    await execFileAsync("node", [napiCliPath(), "build", "--release"], {
      cwd: target,
      timeout: 300_000,
    });

    // Default output is `<binaryName>.node` at the crate root, no platform triple.
    const addonPath = join(target, `${name}.node`);
    assert.ok(await exists(addonPath), `expected ${name}.node to be produced`);

    // Load it in-process and assert the sample exports exist and work.
    const addon = require(addonPath);
    const keys = Object.keys(addon).sort();
    assert.deepEqual(keys, ["add", "sumTo"], `unexpected exports: ${keys}`);
    assert.equal(addon.add(2, 3), 5);
    assert.equal(await addon.sumTo(10), 55);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
