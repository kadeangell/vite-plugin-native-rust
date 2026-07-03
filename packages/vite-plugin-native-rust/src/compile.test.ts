import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { atomicCopy, ensureCrateBinaryName } from "./compile.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "vite-rust-compile-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function tmpFiles(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes(".tmp-"));
}

test("atomicCopy writes the destination and leaves no temp file behind", () => {
  const dir = join(root, "ok");
  mkdirSync(dir, { recursive: true });
  const src = join(dir, "src.bin");
  const dest = join(dir, "dest.node");
  writeFileSync(src, "payload");

  atomicCopy(src, dest);

  assert.equal(readFileSync(dest, "utf8"), "payload");
  assert.deepEqual(tmpFiles(dir), [], "no .tmp- file remains on success");
});

test("atomicCopy cleans up its temp file when the copy source is missing", () => {
  const dir = join(root, "fail");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "dest.node");

  assert.throws(() => atomicCopy(join(dir, "does-not-exist"), dest));
  assert.ok(!readdirSync(dir).includes("dest.node"), "no partial destination");
  assert.deepEqual(tmpFiles(dir), [], "temp file removed after a failed copy");
});

test("concurrent writers converge on a complete destination, no temp left behind", () => {
  const dir = join(root, "concurrent");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "dest.node");

  const srcA = join(dir, "a.bin");
  const srcB = join(dir, "b.bin");
  writeFileSync(srcA, "AAAA");
  writeFileSync(srcB, "BBBB");

  // Distinct tmpTag simulates two OS processes writing the same cache path.
  atomicCopy(srcA, dest, "pidA");
  atomicCopy(srcB, dest, "pidB");

  const final = readFileSync(dest, "utf8");
  assert.ok(final === "AAAA" || final === "BBBB", "destination is one whole source");
  assert.equal(final.length, 4, "never a torn/partial file");
  assert.deepEqual(tmpFiles(dir), [], "each writer consumed its own temp via rename");
});

test("ensureCrateBinaryName generates a package.json by default", () => {
  const crateDir = join(root, "gen-default");
  mkdirSync(crateDir, { recursive: true });

  const result = ensureCrateBinaryName(crateDir);
  assert.equal(result.binaryName, "gen-default");
  assert.match(result.generatedMessage ?? "", /generated/);
  const pkg = JSON.parse(readFileSync(join(crateDir, "package.json"), "utf8"));
  assert.equal(pkg.napi.binaryName, "gen-default");
});

test("ensureCrateBinaryName errors instead of writing when generation is disabled", () => {
  const crateDir = join(root, "no-gen");
  mkdirSync(crateDir, { recursive: true });

  assert.throws(
    () => ensureCrateBinaryName(crateDir, false),
    /generateCratePackageJson is disabled/,
  );
  assert.ok(
    !readdirSync(crateDir).includes("package.json"),
    "no package.json written when generation is disabled",
  );
});

test("ensureCrateBinaryName errors when package.json lacks napi.binaryName and generation is off", () => {
  const crateDir = join(root, "no-gen-partial");
  mkdirSync(crateDir, { recursive: true });
  writeFileSync(join(crateDir, "package.json"), JSON.stringify({ name: "x" }));

  assert.throws(
    () => ensureCrateBinaryName(crateDir, false),
    /without napi\.binaryName/,
  );
});

test("ensureCrateBinaryName respects an existing napi.binaryName without rewriting", () => {
  const crateDir = join(root, "existing");
  mkdirSync(crateDir, { recursive: true });
  const original = `${JSON.stringify({ name: "x", napi: { binaryName: "custom" } })}`;
  writeFileSync(join(crateDir, "package.json"), original);

  const result = ensureCrateBinaryName(crateDir, false);
  assert.equal(result.binaryName, "custom");
  assert.equal(result.generatedMessage, null);
  assert.equal(readFileSync(join(crateDir, "package.json"), "utf8"), original);
});
