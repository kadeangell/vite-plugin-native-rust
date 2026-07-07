import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CompileParams } from "./compile.ts";
import { resolveOptions } from "./options.ts";
import {
  type CompilePipelineDeps,
  ensureCrateCompiled,
  prewarmCrates,
  prewarmManifestPath,
  readPrewarmManifest,
  recordCrateInManifest,
} from "./prewarm.ts";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vite-rust-prewarm-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A minimal on-disk crate: Cargo.toml, napi package.json, one source file. */
function makeCrate(parent: string, name: string): string {
  const crateDir = join(parent, name);
  mkdirSync(join(crateDir, "src"), { recursive: true });
  writeFileSync(
    join(crateDir, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.1.0"\n`,
  );
  writeFileSync(
    join(crateDir, "package.json"),
    `${JSON.stringify({ name, napi: { binaryName: name } })}\n`,
  );
  writeFileSync(join(crateDir, "src", "lib.rs"), "// fixture\n");
  return crateDir;
}

/** Pipeline deps with the heavy externals stubbed; compile calls recorded. */
function stubDeps(overrides: Partial<CompilePipelineDeps> = {}): {
  deps: Partial<CompilePipelineDeps>;
  compileCalls: CompileParams[];
} {
  const compileCalls: CompileParams[] = [];
  const deps: Partial<CompilePipelineDeps> = {
    collectInputs: async (crateDir) => [join(crateDir, "Cargo.toml")],
    resolveBin: () => "/stub/napi",
    toolchainString: async () => "toolchain-test",
    assertCargo: async () => {},
    compile: async (params) => {
      compileCalls.push(params);
    },
    ...overrides,
  };
  return { deps, compileCalls };
}

const baseOpts = resolveOptions({ logLevel: "silent" });

// ---------------------------------------------------------------------------
// Manifest round-trip
// ---------------------------------------------------------------------------

test("manifest round-trips crate dirs, dedupes, and prunes stale entries", () => {
  const root = tempDir();
  const cacheBase = join(root, "cache");
  const crateA = makeCrate(root, "crate-a");
  const crateB = makeCrate(root, "crate-b");

  assert.deepEqual(readPrewarmManifest(cacheBase), [], "missing manifest reads empty");

  recordCrateInManifest(cacheBase, crateA);
  recordCrateInManifest(cacheBase, crateB);
  recordCrateInManifest(cacheBase, crateA); // duplicate record
  assert.deepEqual(readPrewarmManifest(cacheBase), [crateA, crateB].sort());

  // A crate whose Cargo.toml disappeared is filtered on read...
  rmSync(join(crateB, "Cargo.toml"));
  assert.deepEqual(readPrewarmManifest(cacheBase), [crateA]);
  // ...and pruned from the file on the next write.
  recordCrateInManifest(cacheBase, crateA);
  const onDisk = JSON.parse(readFileSync(prewarmManifestPath(cacheBase), "utf8")) as {
    crates: string[];
  };
  assert.deepEqual(onDisk.crates, [crateA]);
});

test("readPrewarmManifest tolerates corrupt or wrong-shaped manifests", () => {
  const root = tempDir();
  const cacheBase = join(root, "cache");
  mkdirSync(cacheBase, { recursive: true });
  const path = prewarmManifestPath(cacheBase);

  writeFileSync(path, "not json {{{");
  assert.deepEqual(readPrewarmManifest(cacheBase), [], "garbage JSON reads empty");

  writeFileSync(path, JSON.stringify({ version: 99, crates: ["/x"] }));
  assert.deepEqual(readPrewarmManifest(cacheBase), [], "unknown version reads empty");

  writeFileSync(path, JSON.stringify({ version: 1, crates: [42, null] }));
  assert.deepEqual(readPrewarmManifest(cacheBase), [], "non-string entries read empty");
});

test("recordCrateInManifest never throws — a write failure only warns", () => {
  const root = tempDir();
  // Make `cacheBase` unusable as a directory by creating it as a FILE.
  const blocked = join(root, "cache-is-a-file");
  writeFileSync(blocked, "occupied");
  const warnings: string[] = [];
  recordCrateInManifest(blocked, makeCrate(root, "crate-a"), (m) => warnings.push(m));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pre-warm manifest/);
});

// ---------------------------------------------------------------------------
// Pre-warm ↔ load coalescing (the shared dedupe key)
// ---------------------------------------------------------------------------

test("a concurrent load while pre-warming coalesces onto one compile", async () => {
  const root = tempDir();
  const cacheBase = join(root, "cache");
  const crateDir = makeCrate(root, "crate-a");
  recordCrateInManifest(cacheBase, crateDir);

  // A compile stub slow enough that the "load" arrives while it is in flight.
  const compileCalls: CompileParams[] = [];
  const { deps } = stubDeps({
    compile: async (params) => {
      compileCalls.push(params);
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  });

  const prewarmPromise = prewarmCrates(
    { root, cacheBase, opts: baseOpts, onLog: () => {}, onWarn: () => {} },
    deps,
  );
  // Simulates the `load` hook: same crate, same pipeline, same deps.
  const loadPromise = ensureCrateCompiled(
    {
      crateDir,
      cacheBase,
      opts: baseOpts,
      watchMode: true,
      underVitest: false,
      onWarn: () => {},
    },
    deps,
  );

  const [prewarmed, loaded] = await Promise.all([prewarmPromise, loadPromise]);
  assert.deepEqual(prewarmed, { warmed: [crateDir], failed: [] });
  assert.equal(
    compileCalls.length,
    1,
    "pre-warm and load must share one in-flight compile, not race two",
  );
  assert.equal(
    loaded.cachePath,
    compileCalls[0].cachePath,
    "load resolves to the exact cachePath the pre-warm compiled",
  );
});

test("ensureCrateCompiled derives the same dedupe key for identical inputs", async () => {
  const root = tempDir();
  const cacheBase = join(root, "cache");
  const crateDir = makeCrate(root, "crate-a");
  const { deps } = stubDeps();

  const params = {
    crateDir,
    cacheBase,
    opts: baseOpts,
    watchMode: true,
    underVitest: false,
    onWarn: () => {},
  };
  const first = await ensureCrateCompiled(params, deps);
  const second = await ensureCrateCompiled(params, deps);
  assert.equal(first.cachePath, second.cachePath);
  assert.equal(first.profile, "debug", "dev/watch defaults to the debug profile");
  assert.match(first.cachePath, /crate-a-[0-9a-f]{64}-debug\.node$/);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test("a pre-warm compile failure is non-fatal: warns and reports, never throws", async () => {
  const root = tempDir();
  const cacheBase = join(root, "cache");
  const crateDir = makeCrate(root, "crate-a");
  recordCrateInManifest(cacheBase, crateDir);

  const { deps } = stubDeps({
    compile: async () => {
      throw new Error("cargo exploded");
    },
  });
  const warnings: string[] = [];
  const result = await prewarmCrates(
    { root, cacheBase, opts: baseOpts, onLog: () => {}, onWarn: (m) => warnings.push(m) },
    deps,
  );
  assert.deepEqual(result, { warmed: [], failed: [crateDir] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pre-warm failed/);
  assert.match(warnings[0], /cargo exploded/);
});

test("prewarm: false short-circuits without touching the pipeline", async () => {
  const root = tempDir();
  const cacheBase = join(root, "cache");
  recordCrateInManifest(cacheBase, makeCrate(root, "crate-a"));

  const { deps, compileCalls } = stubDeps();
  const result = await prewarmCrates(
    {
      root,
      cacheBase,
      opts: resolveOptions({ prewarm: false }),
      onLog: () => {},
      onWarn: () => {},
    },
    deps,
  );
  assert.deepEqual(result, { warmed: [], failed: [] });
  assert.equal(compileCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Anchor discovery + logging
// ---------------------------------------------------------------------------

test("prewarm anchors accept .rs files and crate dirs; bad anchors warn and skip", async () => {
  const root = tempDir();
  const cacheBase = join(root, "cache");
  const crateA = makeCrate(root, "crate-a");
  const crateB = makeCrate(root, "crate-b");

  const { deps, compileCalls } = stubDeps();
  const warnings: string[] = [];
  const result = await prewarmCrates(
    {
      root,
      cacheBase,
      opts: resolveOptions({
        logLevel: "silent",
        prewarm: [
          join(crateA, "src", "lib.rs"), // absolute .rs file
          "crate-b", // root-relative crate dir
          "does/not/exist", // missing → warn + skip
        ],
      }),
      onLog: () => {},
      onWarn: (m) => warnings.push(m),
    },
    deps,
  );
  assert.deepEqual(new Set(result.warmed), new Set([crateA, crateB]));
  assert.deepEqual(result.failed, []);
  assert.equal(compileCalls.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /does\/not\/exist/);
});

test("progress lines respect logLevel; nothing is logged with no crates", async () => {
  const root = tempDir();
  const cacheBase = join(root, "cache");
  const crateDir = makeCrate(root, "crate-a");
  recordCrateInManifest(cacheBase, crateDir);
  const { deps } = stubDeps();

  const silentLogs: string[] = [];
  await prewarmCrates(
    { root, cacheBase, opts: baseOpts, onLog: (m) => silentLogs.push(m), onWarn: () => {} },
    deps,
  );
  assert.deepEqual(silentLogs, [], "logLevel: silent suppresses progress lines");

  // Fresh cache dir (empty manifest) at info level: no crates → no log lines.
  const quietLogs: string[] = [];
  await prewarmCrates(
    {
      root,
      cacheBase: join(root, "other-cache"),
      opts: resolveOptions({}),
      onLog: (m) => quietLogs.push(m),
      onWarn: () => {},
    },
    deps,
  );
  assert.deepEqual(quietLogs, []);

  const infoLogs: string[] = [];
  await prewarmCrates(
    {
      root,
      cacheBase,
      opts: resolveOptions({}),
      onLog: (m) => infoLogs.push(m),
      onWarn: () => {},
    },
    deps,
  );
  assert.equal(infoLogs.length, 2, "start + completion lines at info level");
  assert.match(infoLogs[0], /pre-warming 1 crate/);
  assert.match(infoLogs[1], /1\/1/);
});
