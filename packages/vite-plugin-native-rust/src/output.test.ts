import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  ensureAddonsBesideChunks,
  type BundleEntry,
  type EmittedAddon,
  type OutputFs,
} from "./output.ts";

const OUT = "/out";
const ADDON = "native-abc.node";
const CACHE = "/cache/native-abc.node";

const addon: EmittedAddon = { fileName: ADDON, cachePath: CACHE };

/** In-memory fs seam: `present` seeds existing paths; copies are recorded. */
function fakeFs(present: string[] = []): OutputFs & { copies: Array<[string, string]> } {
  const set = new Set(present);
  const copies: Array<[string, string]> = [];
  return {
    copies,
    existsSync: (p) => set.has(p),
    copyFileSync: (src, dest) => {
      copies.push([src, dest]);
      set.add(dest);
    },
  };
}

function chunk(fileName: string, code: string): BundleEntry {
  return { type: "chunk", fileName, code };
}

test("no-op when the addon already sits beside the referencing chunk", () => {
  const sibling = join(OUT, "nodejs_a", ADDON);
  const fs = fakeFs([sibling]);
  const bundle = { "nodejs_a/index.js": chunk("nodejs_a/index.js", `new URL("${ADDON}")`) };

  const placements = ensureAddonsBesideChunks(OUT, bundle, [addon], fs);

  assert.deepEqual(placements, []);
  assert.deepEqual(fs.copies, []);
});

test("copies the addon from the compile cache when a referencing chunk is missing it", () => {
  const fs = fakeFs([CACHE]); // cache present, sibling absent
  const bundle = { "nodejs_a/index.js": chunk("nodejs_a/index.js", `require("${ADDON}")`) };

  const placements = ensureAddonsBesideChunks(OUT, bundle, [addon], fs);

  const expected = join(OUT, "nodejs_a", ADDON);
  assert.deepEqual(placements, [{ chunk: "nodejs_a/index.js", addon: ADDON, to: expected }]);
  assert.deepEqual(fs.copies, [[CACHE, expected]]);
});

test("recovers every referencing chunk across split bundles", () => {
  const fs = fakeFs([CACHE]);
  const bundle = {
    "nodejs_a/index.js": chunk("nodejs_a/index.js", `new URL("${ADDON}", import.meta.url)`),
    "nodejs_b/index.js": chunk("nodejs_b/index.js", `new URL("${ADDON}", import.meta.url)`),
    "nodejs_a/other.js": chunk("nodejs_a/other.js", "no addon here"),
  };

  const placements = ensureAddonsBesideChunks(OUT, bundle, [addon], fs);

  assert.equal(placements.length, 2, "only the two referencing chunks get a copy");
  assert.deepEqual(
    placements.map((p) => p.to).sort(),
    [join(OUT, "nodejs_a", ADDON), join(OUT, "nodejs_b", ADDON)].sort(),
  );
});

test("falls back to a copy Rollup wrote elsewhere when the cache is gone", () => {
  const writtenAsset = join(OUT, ADDON); // Rollup wrote it flat at the output root
  const fs = fakeFs([writtenAsset]); // cache absent, flat asset present
  const bundle = {
    [ADDON]: { type: "asset", fileName: ADDON } as BundleEntry,
    "nodejs_a/index.js": chunk("nodejs_a/index.js", `new URL("${ADDON}")`),
  };

  const placements = ensureAddonsBesideChunks(OUT, bundle, [addon], fs);

  const expected = join(OUT, "nodejs_a", ADDON);
  assert.deepEqual(fs.copies, [[writtenAsset, expected]]);
  assert.equal(placements.length, 1);
});

test("throws an actionable error when the addon cannot be recovered", () => {
  const fs = fakeFs([]); // nothing exists: no sibling, no cache, no written copy
  const bundle = { "nodejs_a/index.js": chunk("nodejs_a/index.js", `new URL("${ADDON}")`) };

  assert.throws(
    () => ensureAddonsBesideChunks(OUT, bundle, [addon], fs),
    (err: Error) => {
      assert.match(err.message, /vite-plugin-native-rust/);
      assert.match(err.message, /nodejs_a\/index\.js/, "names the referencing chunk");
      assert.match(err.message, new RegExp(ADDON), "names the missing addon");
      assert.match(err.message, /cold start/, "explains why it fails loudly");
      return true;
    },
  );
});

test("assets and non-referencing chunks are ignored", () => {
  const fs = fakeFs([]); // would throw if any referencing chunk needed recovery
  const bundle = {
    "index.js": chunk("index.js", "plain server code, no native import"),
    "manifest.json": { type: "asset", fileName: "manifest.json" } as BundleEntry,
  };

  const placements = ensureAddonsBesideChunks(OUT, bundle, [addon], fs);

  assert.deepEqual(placements, []);
  assert.deepEqual(fs.copies, []);
});
