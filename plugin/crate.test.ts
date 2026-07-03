import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { collectCrateInputs, findCargoToml, hashCrate } from "./crate.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "vite-rust-crate-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCrate(name: string, files: Record<string, string>): string {
  const crateDir = join(root, name);
  mkdirSync(join(crateDir, "src"), { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(crateDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return crateDir;
}

test("findCargoToml walks up nested directories to the crate root", () => {
  const crateDir = makeCrate("nested", {
    "Cargo.toml": "[package]\nname = \"nested\"\n",
    "src/lib.rs": "pub fn a() {}",
    "src/deep/inner/mod.rs": "pub fn b() {}",
  });

  const deepRs = join(crateDir, "src", "deep", "inner", "mod.rs");
  assert.equal(findCargoToml(deepRs), crateDir);

  // From a file directly beside Cargo.toml too.
  assert.equal(findCargoToml(join(crateDir, "src", "lib.rs")), crateDir);
});

test("findCargoToml returns null when no Cargo.toml exists above the file", () => {
  const noCrate = join(root, "no-crate");
  mkdirSync(join(noCrate, "src"), { recursive: true });
  writeFileSync(join(noCrate, "src", "lib.rs"), "pub fn a() {}");

  assert.equal(findCargoToml(join(noCrate, "src", "lib.rs")), null);
});

test("collectCrateInputs returns sorted absolute paths and treats Cargo.lock as optional", () => {
  const crateDir = makeCrate("inputs", {
    "Cargo.toml": "[package]\nname = \"inputs\"\n",
    "src/lib.rs": "pub fn a() {}",
    "src/util/helpers.rs": "pub fn b() {}",
  });

  const withoutLock = collectCrateInputs(crateDir);
  assert.deepEqual(withoutLock, [...withoutLock].sort(), "should be sorted");
  assert.ok(withoutLock.every((p) => p.startsWith(crateDir)), "absolute paths");
  assert.ok(!withoutLock.some((p) => p.endsWith("Cargo.lock")), "no lock yet");
  assert.ok(withoutLock.some((p) => p.endsWith("Cargo.toml")));
  assert.ok(withoutLock.some((p) => p.endsWith("helpers.rs")));

  writeFileSync(join(crateDir, "Cargo.lock"), "# lock\n");
  const withLock = collectCrateInputs(crateDir);
  assert.ok(withLock.some((p) => p.endsWith("Cargo.lock")), "lock now included");
  assert.equal(withLock.length, withoutLock.length + 1);
});

test("hashCrate is stable across repeated runs on unchanged sources", () => {
  const crateDir = makeCrate("stable", {
    "Cargo.toml": "[package]\nname = \"stable\"\n",
    "src/lib.rs": "pub fn a() {}",
  });

  assert.equal(hashCrate(crateDir), hashCrate(crateDir));
});

test("hashCrate changes when file contents change", () => {
  const crateDir = makeCrate("content", {
    "Cargo.toml": "[package]\nname = \"content\"\n",
    "src/lib.rs": "pub fn a() {}",
  });

  const before = hashCrate(crateDir);
  writeFileSync(join(crateDir, "src", "lib.rs"), "pub fn a() { let x = 1; }");
  assert.notEqual(hashCrate(crateDir), before);
});

test("hashCrate changes when a file is renamed even with identical contents", () => {
  const crateDir = makeCrate("rename", {
    "Cargo.toml": "[package]\nname = \"rename\"\n",
    "src/lib.rs": "pub fn a() {}",
    "src/one.rs": "pub fn shared() {}",
  });

  const before = hashCrate(crateDir);
  renameSync(join(crateDir, "src", "one.rs"), join(crateDir, "src", "two.rs"));
  assert.notEqual(
    hashCrate(crateDir),
    before,
    "path is folded into the hash, so a rename must change it",
  );
});

test("hashCrate throws a clear error naming the directory when the crate is missing", () => {
  const missing = join(root, "does-not-exist");
  assert.throws(
    () => hashCrate(missing),
    (err: Error) => {
      assert.match(err.message, /Cannot hash Rust crate/);
      assert.ok(err.message.includes(missing), "error names the path");
      assert.ok(!/ENOENT/.test(err.message) || err.message.includes(missing));
      return true;
    },
  );
});
