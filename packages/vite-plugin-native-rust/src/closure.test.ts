import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  collectClosureInputs,
  resetClosureCacheForTests,
  type CargoMetadata,
  type MetadataRunner,
} from "./closure.ts";
import { hashInputs } from "./crate.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "vite-rust-closure-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Two local crates (app + a path-dep `dep`) plus one registry package. */
function makeWorkspace(name: string): { appDir: string; depDir: string; wsDir: string } {
  const wsDir = join(root, name);
  const appDir = join(wsDir, "app");
  const depDir = join(wsDir, "dep");
  mkdirSync(join(appDir, "src"), { recursive: true });
  mkdirSync(join(depDir, "src"), { recursive: true });

  writeFileSync(join(wsDir, "Cargo.toml"), '[workspace]\nmembers = ["app", "dep"]\nresolver = "2"\n');
  writeFileSync(join(wsDir, "Cargo.lock"), "# lock\n");
  writeFileSync(
    join(appDir, "Cargo.toml"),
    '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ndep = { path = "../dep" }\n',
  );
  writeFileSync(join(appDir, "src", "lib.rs"), "pub fn a() {}");
  writeFileSync(join(depDir, "Cargo.toml"), '[package]\nname = "dep"\nversion = "0.1.0"\nedition = "2021"\n');
  writeFileSync(join(depDir, "src", "lib.rs"), "pub fn d() {}");
  return { appDir, depDir, wsDir };
}

/** A metadata runner that returns a hand-built graph and counts its calls. */
function stubRunner(metadata: CargoMetadata): { run: MetadataRunner; calls: () => number } {
  let calls = 0;
  return {
    run: async () => {
      calls++;
      return metadata;
    },
    calls: () => calls,
  };
}

test("closure includes local path-deps + workspace manifest + lockfile, excludes registry", async () => {
  resetClosureCacheForTests();
  const { appDir, depDir, wsDir } = makeWorkspace("stub-graph");
  const registryManifest = join(root, "fake-registry", "bitflags-2.13.0", "Cargo.toml");

  const { run } = stubRunner({
    workspace_root: wsDir,
    packages: [
      { name: "app", manifest_path: join(appDir, "Cargo.toml"), source: null },
      { name: "dep", manifest_path: join(depDir, "Cargo.toml"), source: null },
      {
        name: "bitflags",
        manifest_path: registryManifest,
        source: "registry+https://github.com/rust-lang/crates.io-index",
      },
    ],
  });

  const inputs = await collectClosureInputs(appDir, { runMetadata: run });

  assert.ok(inputs.includes(join(appDir, "src", "lib.rs")), "app source included");
  assert.ok(inputs.includes(join(depDir, "src", "lib.rs")), "path-dep source included");
  assert.ok(inputs.includes(join(depDir, "Cargo.toml")), "path-dep manifest included");
  assert.ok(inputs.includes(join(wsDir, "Cargo.toml")), "workspace manifest included");
  assert.ok(inputs.includes(join(wsDir, "Cargo.lock")), "lockfile included");
  assert.ok(
    !inputs.some((p) => p.includes("fake-registry")),
    "registry dependency is excluded",
  );
});

test("metadata is cached per crate-dir and re-run only when a manifest mtime changes", async () => {
  resetClosureCacheForTests();
  const { appDir, wsDir } = makeWorkspace("cache-guard");
  const { run, calls } = stubRunner({
    workspace_root: wsDir,
    packages: [{ name: "app", manifest_path: join(appDir, "Cargo.toml"), source: null }],
  });

  await collectClosureInputs(appDir, { runMetadata: run });
  await collectClosureInputs(appDir, { runMetadata: run });
  assert.equal(calls(), 1, "second call reuses the cached metadata (no re-run)");

  // A source-only edit must NOT trigger a re-run of metadata.
  writeFileSync(join(appDir, "src", "lib.rs"), "pub fn a() { let x = 1; }");
  await collectClosureInputs(appDir, { runMetadata: run });
  assert.equal(calls(), 1, "editing a .rs file does not re-run metadata");

  // A manifest change (dependency graph may have changed) forces a re-run.
  const future = new Date(Date.now() + 10_000);
  utimesSync(join(appDir, "Cargo.toml"), future, future);
  await collectClosureInputs(appDir, { runMetadata: run });
  assert.equal(calls(), 2, "a manifest mtime change re-runs metadata");
});

test("falls back to single-crate hashing (with a warning) when metadata fails", async () => {
  resetClosureCacheForTests();
  const { appDir } = makeWorkspace("fallback");
  const warnings: string[] = [];

  const failing: MetadataRunner = async () => {
    throw new Error("cargo exploded");
  };
  const inputs = await collectClosureInputs(appDir, {
    runMetadata: failing,
    onWarn: (m) => warnings.push(m),
  });

  assert.ok(inputs.includes(join(appDir, "Cargo.toml")), "single-crate manifest present");
  assert.ok(inputs.includes(join(appDir, "src", "lib.rs")), "single-crate source present");
  assert.ok(
    !inputs.some((p) => p.includes(`${join(root, "fallback")}/dep`)),
    "fallback does not reach the sibling path-dep it could not resolve",
  );
  assert.equal(warnings.length, 1, "one warning surfaced");
  assert.match(warnings[0], /falling back to single-crate/);
});

test(
  "real cargo metadata: changing a path-dep's source changes the closure hash",
  { skip: hasCargo() ? false : "cargo not installed" },
  async () => {
    resetClosureCacheForTests();
    const { appDir, depDir } = makeWorkspace("real-cargo");

    const before = await collectClosureInputs(appDir);
    assert.ok(
      before.includes(join(depDir, "src", "lib.rs")),
      "real metadata resolves the path-dep source into the closure",
    );
    assert.ok(
      before.every((p) => p.startsWith(join(root, "real-cargo"))),
      "no registry paths leak into the closure (all under the workspace)",
    );
    const hashBefore = hashInputs(appDir, before);

    // Change the sibling path-dep only. The old single-crate hash would miss it.
    writeFileSync(join(depDir, "src", "lib.rs"), "pub fn d() { let y = 2; }");
    const afterInputs = await collectClosureInputs(appDir);
    const hashAfter = hashInputs(appDir, afterInputs);

    assert.notEqual(hashAfter, hashBefore, "a path-dep change must invalidate the hash");
  },
);
