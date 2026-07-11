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
  assert.equal(
    typeof plugin.configureServer,
    "function",
    "dev pre-warm hook (issue #5)",
  );
});

test("config hook forces ssrEmitAssets so the native addon ships in SSR builds", () => {
  const plugin = rustPlugin();
  // `config` is a plain function here; call it the way Vite would (it now
  // takes the user config to derive root for crate-target watch ignores).
  const partial = (
    plugin.config as (c: object) => { build?: { ssrEmitAssets?: boolean } }
  )({});
  assert.equal(partial.build?.ssrEmitAssets, true);
});
