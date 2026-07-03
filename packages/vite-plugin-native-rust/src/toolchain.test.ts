import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import {
  getToolchainKey,
  resetToolchainCacheForTests,
  toolchainKeyString,
} from "./toolchain.ts";
import { hashInputs } from "./crate.ts";

let root: string;

beforeEach(() => {
  resetToolchainCacheForTests();
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A fake `@napi-rs/cli` install: `<pkg>/bin/napi.js` + `<pkg>/package.json`. */
function fakeNapiBin(version: string): string {
  root ??= mkdtempSync(join(tmpdir(), "vite-rust-toolchain-"));
  const pkgDir = join(root, `napi-${version}`);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@napi-rs/cli", version }),
  );
  return join(pkgDir, "bin", "napi.js");
}

test("getToolchainKey reads the napi-cli version from the resolved bin's package", async () => {
  const key = await getToolchainKey(fakeNapiBin("3.4.5"));
  assert.equal(key.napiCli, "3.4.5");
  assert.match(key.rustc, /rustc|unavailable/, "rustc string is populated");
});

test("a null napiBin yields a stable sentinel instead of throwing", async () => {
  const key = await getToolchainKey(null);
  assert.equal(key.napiCli, "napi-cli:unresolved");
});

test("toolchainKeyString changes when the napi-cli version changes", async () => {
  const a = toolchainKeyString(await getToolchainKey(fakeNapiBin("3.4.5")));
  const b = toolchainKeyString(await getToolchainKey(fakeNapiBin("3.5.0")));
  assert.notEqual(a, b);
});

test("mixing the toolchain key into hashInputs changes the digest", () => {
  const dir = (root ??= mkdtempSync(join(tmpdir(), "vite-rust-toolchain-")));
  const file = join(dir, "a.rs");
  writeFileSync(file, "pub fn a() {}");

  const base = hashInputs(dir, [file]);
  const withToolchain = hashInputs(dir, [file], "rustc=1.0.0\0napi-cli=3.4.5");
  const upgraded = hashInputs(dir, [file], "rustc=1.1.0\0napi-cli=3.4.5");

  assert.notEqual(base, withToolchain, "adding a toolchain key changes the hash");
  assert.notEqual(withToolchain, upgraded, "a rustc bump invalidates the hash");
});
