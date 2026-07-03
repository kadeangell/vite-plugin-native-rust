import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveOptions } from "./options.ts";

test("resolveOptions fills behavior-preserving defaults with no arguments", () => {
  const opts = resolveOptions();
  assert.equal(opts.cacheDir, null, "cacheDir default is derived from root later");
  assert.equal(opts.profile, null, "profile default is auto (null)");
  assert.deepEqual(opts.napiArgs, []);
  assert.equal(opts.generateCratePackageJson, true);
  assert.equal(opts.emitTypes, true);
  assert.equal(opts.logLevel, "info");
});

test("resolveOptions({}) equals resolveOptions() — empty object is the same as absent", () => {
  assert.deepEqual(resolveOptions({}), resolveOptions());
});

test("resolveOptions passes through valid values", () => {
  const opts = resolveOptions({
    cacheDir: "custom/cache",
    profile: "release",
    napiArgs: ["--features", "simd"],
    generateCratePackageJson: false,
    emitTypes: false,
    logLevel: "silent",
  });
  assert.equal(opts.cacheDir, "custom/cache");
  assert.equal(opts.profile, "release");
  assert.deepEqual(opts.napiArgs, ["--features", "simd"]);
  assert.equal(opts.generateCratePackageJson, false);
  assert.equal(opts.emitTypes, false);
  assert.equal(opts.logLevel, "silent");
});

test("resolveOptions copies napiArgs so later caller mutation cannot leak in", () => {
  const args = ["--features", "simd"];
  const opts = resolveOptions({ napiArgs: args });
  args.push("--evil");
  assert.deepEqual(opts.napiArgs, ["--features", "simd"]);
});

test("resolveOptions rejects an empty or non-string cacheDir", () => {
  assert.throws(() => resolveOptions({ cacheDir: "" }), /cacheDir/);
  assert.throws(
    () => resolveOptions({ cacheDir: "   " }),
    /cacheDir/,
    "whitespace-only is empty",
  );
  // @ts-expect-error deliberate wrong type at the boundary
  assert.throws(() => resolveOptions({ cacheDir: 5 }), /cacheDir/);
});

test("resolveOptions rejects an unknown profile", () => {
  // @ts-expect-error deliberate wrong value at the boundary
  assert.throws(() => resolveOptions({ profile: "fast" }), /profile/);
});

test("resolveOptions rejects a non-string-array napiArgs", () => {
  // @ts-expect-error deliberate wrong type at the boundary
  assert.throws(() => resolveOptions({ napiArgs: "--release" }), /napiArgs/);
  // @ts-expect-error deliberate wrong element type at the boundary
  assert.throws(() => resolveOptions({ napiArgs: [1, 2] }), /napiArgs/);
});

test("resolveOptions rejects non-boolean flags", () => {
  // @ts-expect-error deliberate wrong type at the boundary
  assert.throws(() => resolveOptions({ generateCratePackageJson: "yes" }), /generateCratePackageJson/);
  // @ts-expect-error deliberate wrong type at the boundary
  assert.throws(() => resolveOptions({ emitTypes: 1 }), /emitTypes/);
});

test("resolveOptions rejects an unknown logLevel", () => {
  // @ts-expect-error deliberate wrong value at the boundary
  assert.throws(() => resolveOptions({ logLevel: "verbose" }), /logLevel/);
});

test("resolveOptions rejects a non-object argument", () => {
  // @ts-expect-error deliberate wrong type at the boundary
  assert.throws(() => resolveOptions(42), /options object/);
});
