import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

import {
  type AddonExport,
  buildModuleSource,
  devModuleSource,
  enumerateExports,
} from "./codegen.ts";

let dir: string;

// A stand-in "addon": a CommonJS module `createRequire` can load exactly like a
// real `.node`, so the generated loader can be exercised without cargo. Mixes a
// sync fn, an async fn, and a non-function value to cover every codegen branch.
let fakeAddonPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "vite-rust-codegen-"));
  fakeAddonPath = join(dir, "fake-addon.cjs");
  writeFileSync(
    fakeAddonPath,
    [
      "module.exports.add = (a, b) => a + b;",
      "module.exports.sumTo = async (n) => n * 2;",
      "module.exports.answer = 42;",
    ].join("\n"),
  );
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Make a build-module source runnable off the bundler: substitute Rollup's
 * `import.meta.ROLLUP_FILE_URL_<refId>` token (which only the bundler resolves)
 * with a literal file URL, write it as an `.mjs`, and return its import URL.
 */
function runnableModule(source: string, refId: string, addonPath: string): string {
  const replaced = source.replace(
    `import.meta.ROLLUP_FILE_URL_${refId}`,
    JSON.stringify(pathToFileURL(addonPath).href),
  );
  const file = join(dir, `mod-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, replaced);
  return pathToFileURL(file).href;
}

test("enumerateExports tags each export with whether it is callable", () => {
  const exports = enumerateExports(fakeAddonPath);
  const byKey = Object.fromEntries(exports.map((e) => [e.key, e.isFunction]));
  assert.deepEqual(byKey, { add: true, sumTo: true, answer: false });
});

test("buildModuleSource: all-function exports leave no eager require at top level", () => {
  const exports: AddonExport[] = [
    { key: "add", isFunction: true },
    { key: "sumTo", isFunction: true },
  ];
  const src = buildModuleSource("ref0", exports);

  assert.match(src, /function __vrLoad\(\)/, "emits the lazy loader");
  // The only require is inside __vrLoad; no `__vrAddon = require(...)` runs at
  // module init, and no bare top-level `__vrLoad()` statement exists.
  assert.doesNotMatch(src, /^\s*(?:var|const|let)\s+__vrAddon\s*=\s*require\(/m);
  assert.doesNotMatch(src, /^\s*__vrLoad\(\);?\s*$/m);
  assert.match(src, /export const add = \(\.\.\.args\) => __vrLoad\(\)\.add\(\.\.\.args\);/);
});

test("buildModuleSource: function wrappers call through and preserve async results", async () => {
  const exports: AddonExport[] = [
    { key: "add", isFunction: true },
    { key: "sumTo", isFunction: true },
  ];
  const url = runnableModule(buildModuleSource("refA", exports), "refA", fakeAddonPath);
  const mod = await import(url);

  assert.equal(mod.add(2, 3), 5, "sync wrapper returns the addon result");
  const total = mod.sumTo(21);
  assert.ok(total instanceof Promise, "async export stays a promise through the wrapper");
  assert.equal(await total, 42);
});

test("buildModuleSource: a missing binary throws a catchable, actionable per-call error", async () => {
  const exports: AddonExport[] = [{ key: "add", isFunction: true }];
  const missing = join(dir, "does-not-exist.cjs");
  const url = runnableModule(buildModuleSource("refB", exports), "refB", missing);

  // Importing must succeed — the loader is lazy, so init does not crash.
  const mod = await import(url);
  assert.equal(typeof mod.add, "function");

  // Calling surfaces the error where a consumer can catch it.
  assert.throws(
    () => mod.add(1, 1),
    (err: Error) => {
      assert.match(err.message, /vite-plugin-native-rust/);
      assert.match(err.message, /not found next to/);
      assert.match(err.message, /does-not-exist\.cjs/, "names the missing path");
      assert.match(err.message, /troubleshooting\.md/, "links the troubleshooting doc");
      return true;
    },
  );
});

test("buildModuleSource: non-function exports load eagerly through the guarded loader", async () => {
  const exports: AddonExport[] = [
    { key: "add", isFunction: true },
    { key: "answer", isFunction: false },
  ];
  const src = buildModuleSource("refC", exports);
  assert.match(src, /export const answer = __vrLoad\(\)\.answer;/, "non-fn export is eager");

  const url = runnableModule(src, "refC", fakeAddonPath);
  const mod = await import(url);
  assert.equal(mod.answer, 42, "eager value is read at module init");
  assert.equal(mod.add(4, 5), 9);
});

test("devModuleSource: eager require of the absolute cache path", () => {
  const exports: AddonExport[] = [
    { key: "add", isFunction: true },
    { key: "answer", isFunction: false },
  ];
  const src = devModuleSource("/abs/cache/x.node", exports);
  assert.match(src, /const addon = require\("\/abs\/cache\/x\.node"\);/);
  assert.match(src, /export const add = addon\.add;/);
  assert.match(src, /export const answer = addon\.answer;/);
});
