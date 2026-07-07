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
  type LockfileRunner,
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

/** A standalone crate (its own workspace root) with NO lockfile — issue #4's shape. */
function makeStandaloneCrate(name: string): string {
  const crateDir = join(root, name);
  mkdirSync(join(crateDir, "src"), { recursive: true });
  writeFileSync(
    join(crateDir, "Cargo.toml"),
    `[package]\nname = "${name.replace(/[^a-z0-9_-]/g, "-")}"\nversion = "0.1.0"\nedition = "2021"\n`,
  );
  writeFileSync(join(crateDir, "src", "lib.rs"), "pub fn f() {}");
  return crateDir;
}

/**
 * A `cargo generate-lockfile` stub that writes a deterministic lockfile the
 * way the real command does (at the crate/workspace root) and counts calls.
 */
function stubLockfileGenerator(contents = "# generated lock\n"): {
  run: LockfileRunner;
  calls: () => number;
} {
  let calls = 0;
  return {
    run: async (crateDir) => {
      calls++;
      writeFileSync(join(crateDir, "Cargo.lock"), contents);
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

// ---------------------------------------------------------------------------
// Issue #4: cache-key stability when Cargo.lock doesn't exist yet.
// ---------------------------------------------------------------------------

test("issue #4: generates a missing lockfile before the first hash and includes it", async () => {
  resetClosureCacheForTests();
  const crateDir = makeStandaloneCrate("lockless");
  const metadata = stubRunner({
    workspace_root: crateDir,
    packages: [{ name: "lockless", manifest_path: join(crateDir, "Cargo.toml"), source: null }],
  });
  const generator = stubLockfileGenerator();

  const inputs = await collectClosureInputs(crateDir, {
    runMetadata: metadata.run,
    runGenerateLockfile: generator.run,
  });

  assert.equal(generator.calls(), 1, "generate-lockfile ran once");
  assert.ok(
    inputs.includes(join(crateDir, "Cargo.lock")),
    "the freshly generated lockfile is part of the hash/watch input set",
  );
});

test("issue #4 regression: key is stable across a simulated multi-pipeline build (one compile, not two)", async () => {
  resetClosureCacheForTests();
  const crateDir = makeStandaloneCrate("two-pipelines");
  const metadata = {
    workspace_root: crateDir,
    packages: [
      { name: "two-pipelines", manifest_path: join(crateDir, "Cargo.toml"), source: null },
    ],
  };
  const generator = stubLockfileGenerator("# lock v1\n");

  // A compile-call spy over the same key→binary cache the plugin uses: a
  // pipeline only compiles when its key has no cached artifact yet.
  const compiledKeys = new Set<string>();
  const compileIfMissing = (key: string): void => {
    if (compiledKeys.has(key)) return;
    compiledKeys.add(key);
    // What `napi build` did to a lockfile-less crate before the fix: cargo
    // resolves and writes Cargo.lock as part of the build. With the fix the
    // file already exists with identical content, so this is a no-op.
    writeFileSync(join(crateDir, "Cargo.lock"), "# lock v1\n");
  };

  // Pipeline 1 (e.g. Nuxt's Vite SSR pass) — fresh process: fresh caches.
  const inputs1 = await collectClosureInputs(crateDir, {
    runMetadata: async () => metadata,
    runGenerateLockfile: generator.run,
  });
  const key1 = hashInputs(crateDir, inputs1);
  compileIfMissing(key1);

  // Pipeline 2 (e.g. the Nitro pass) — simulate a separate process by
  // dropping the in-memory caches; the filesystem state carries over.
  resetClosureCacheForTests();
  const inputs2 = await collectClosureInputs(crateDir, {
    runMetadata: async () => metadata,
    runGenerateLockfile: generator.run,
  });
  const key2 = hashInputs(crateDir, inputs2);
  compileIfMissing(key2);

  assert.equal(key2, key1, "the cache key is identical before and after the first compile");
  assert.equal(compiledKeys.size, 1, "the second pipeline hits the cache — no double compile");
  assert.equal(generator.calls(), 1, "the lockfile is generated once, not per pipeline");
});

test("issue #4: covers the metadata-fallback path (which never created a lockfile)", async () => {
  resetClosureCacheForTests();
  const crateDir = makeStandaloneCrate("fallback-lockless");
  const failingMetadata: MetadataRunner = async () => {
    throw new Error("cargo exploded");
  };
  const generator = stubLockfileGenerator();
  const warnings: string[] = [];

  const inputs = await collectClosureInputs(crateDir, {
    runMetadata: failingMetadata,
    runGenerateLockfile: generator.run,
    onWarn: (m) => warnings.push(m),
  });

  assert.equal(generator.calls(), 1, "generate-lockfile ran despite metadata failing");
  assert.ok(
    inputs.includes(join(crateDir, "Cargo.lock")),
    "single-crate fallback hashing picks up the generated lockfile",
  );
  assert.equal(warnings.length, 1, "only the metadata-fallback warning fired");
  assert.match(warnings[0], /falling back to single-crate/);
});

test("issue #4: skips generation when a lockfile already exists (crate or workspace root)", async () => {
  resetClosureCacheForTests();
  const { appDir, wsDir } = makeWorkspace("has-lock");
  const metadata = stubRunner({
    workspace_root: wsDir,
    packages: [{ name: "app", manifest_path: join(appDir, "Cargo.toml"), source: null }],
  });
  const generator = stubLockfileGenerator();

  // The lockfile lives at the WORKSPACE root, not the crate dir — the upward
  // walk must find it there and never invoke cargo.
  await collectClosureInputs(appDir, {
    runMetadata: metadata.run,
    runGenerateLockfile: generator.run,
  });

  assert.equal(generator.calls(), 0, "no generate-lockfile run when a lockfile exists");
});

test("issue #4: warns once and proceeds with old behavior when generate-lockfile fails", async () => {
  resetClosureCacheForTests();
  const crateDir = makeStandaloneCrate("gen-fails");
  const metadata = stubRunner({
    workspace_root: crateDir,
    packages: [{ name: "gen-fails", manifest_path: join(crateDir, "Cargo.toml"), source: null }],
  });
  let generatorCalls = 0;
  const failingGenerator: LockfileRunner = async () => {
    generatorCalls++;
    throw new Error("no network");
  };
  const warnings: string[] = [];

  const inputs = await collectClosureInputs(crateDir, {
    runMetadata: metadata.run,
    runGenerateLockfile: failingGenerator,
    onWarn: (m) => warnings.push(m),
  });
  // Second load() of the same session must not retry or re-warn.
  await collectClosureInputs(crateDir, {
    runMetadata: metadata.run,
    runGenerateLockfile: failingGenerator,
    onWarn: (m) => warnings.push(m),
  });

  assert.equal(generatorCalls, 1, "failed generation is attempted once per session");
  assert.equal(warnings.length, 1, "exactly one warning");
  assert.match(warnings[0], /generate-lockfile.*failed/s);
  assert.ok(
    !inputs.includes(join(crateDir, "Cargo.lock")),
    "old behavior preserved: hashing proceeds without a lockfile",
  );
});

test(
  "issue #4, real cargo: default runners generate the lockfile and the key survives a real resolve",
  { skip: hasCargo() ? false : "cargo not installed" },
  async () => {
    resetClosureCacheForTests();
    const crateDir = makeStandaloneCrate("real-lockless");

    const inputs1 = await collectClosureInputs(crateDir);
    assert.ok(
      inputs1.includes(join(crateDir, "Cargo.lock")),
      "real `cargo generate-lockfile` produced a lockfile before the first hash",
    );
    const key1 = hashInputs(crateDir, inputs1);

    // A later pipeline in a fresh process: caches dropped, filesystem kept.
    resetClosureCacheForTests();
    const inputs2 = await collectClosureInputs(crateDir);
    const key2 = hashInputs(crateDir, inputs2);

    assert.equal(key2, key1, "identical keys across simulated pipelines");
  },
);
