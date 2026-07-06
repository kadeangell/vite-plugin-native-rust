import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { rustTestStub } from "./stub.ts";

/** Drive the plugin's resolveId the way Vite would (function form, no context needed). */
function resolveWith(plugin: ReturnType<typeof rustTestStub>, id: string): string | null {
  const fn = plugin.resolveId as (source: string) => string | null;
  return fn(id);
}

test("rustTestStub returns an enforce:'pre' plugin with the expected shape", () => {
  const plugin = rustTestStub({ "/native/src/lib.rs": "./twin.ts" });
  assert.equal(plugin.name, "vite-rust-test-stub");
  assert.equal(plugin.enforce, "pre");
  assert.equal(typeof plugin.resolveId, "function");
});

test("resolveId redirects an id ending with a mapping key to a root-resolved absolute path", () => {
  const plugin = rustTestStub({ "/native/src/lib.rs": "./app/twin.ts" });
  const resolved = resolveWith(plugin, "../../native/src/lib.rs");
  assert.equal(resolved, resolve(process.cwd(), "./app/twin.ts"));
});

test("resolveId passes absolute replacements through unchanged", () => {
  const abs = resolve("/tmp/twin.ts");
  const plugin = rustTestStub({ "/native/src/lib.rs": abs });
  assert.equal(resolveWith(plugin, "./native/src/lib.rs"), abs);
});

test("resolveId ignores the ?query suffix when matching", () => {
  const plugin = rustTestStub({ "/native/src/lib.rs": "./twin.ts" });
  assert.equal(
    resolveWith(plugin, "./native/src/lib.rs?rust"),
    resolve(process.cwd(), "./twin.ts"),
  );
});

test("resolveId returns null for a non-matching id", () => {
  const plugin = rustTestStub({ "/native/src/lib.rs": "./twin.ts" });
  assert.equal(resolveWith(plugin, "./some/other/module.ts"), null);
});

test("resolveId honors configResolved root for relative replacements", () => {
  const plugin = rustTestStub({ "/native/src/lib.rs": "./twin.ts" });
  const configResolved = plugin.configResolved as (config: { root: string }) => void;
  configResolved({ root: "/project/root" });
  assert.equal(resolveWith(plugin, "./native/src/lib.rs"), resolve("/project/root", "./twin.ts"));
});

test("rustTestStub rejects a non-object mapping", () => {
  assert.throws(() => rustTestStub(null as never), /mapping object/);
  assert.throws(() => rustTestStub([] as never), /mapping object/);
});

test("rustTestStub rejects an empty mapping", () => {
  assert.throws(() => rustTestStub({}), /empty/);
});

test("rustTestStub rejects empty or non-string values", () => {
  assert.throws(() => rustTestStub({ "/lib.rs": "" }), /non-empty string/);
  assert.throws(() => rustTestStub({ "/lib.rs": 42 as never }), /non-empty string/);
});

test("rustTestStub rejects an empty key", () => {
  assert.throws(() => rustTestStub({ "": "./twin.ts" }), /non-empty string/);
});
