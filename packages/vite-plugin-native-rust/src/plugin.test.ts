import assert from "node:assert/strict";
import { test } from "node:test";

import { rustPlugin } from "./index.ts";

test("plugin exposes the expected Vite hook surface", () => {
  const plugin = rustPlugin();
  assert.equal(plugin.name, "vite-rust");
  assert.equal(plugin.enforce, "pre");
  assert.equal(typeof plugin.config, "function");
  assert.equal(typeof plugin.resolveId, "function");
  assert.equal(typeof plugin.load, "function");
});

test("config hook forces ssrEmitAssets so the native addon ships in SSR builds", () => {
  const plugin = rustPlugin();
  // `config` is a plain function here; call it the way Vite would.
  const partial = (plugin.config as () => { build?: { ssrEmitAssets?: boolean } })();
  assert.equal(partial.build?.ssrEmitAssets, true);
});
