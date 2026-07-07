import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  collectAddonShipments,
  nitroPreserveImportMeta,
  nitroRustPlugin,
  nitroShipAddons,
  repairMangledFileUrlTokens,
  type ShipFs,
} from "./nitro.ts";

// ── repairMangledFileUrlTokens ──────────────────────────────────────────────

test("repairs a mangled ROLLUP_FILE_URL token into an entry-relative URL", () => {
  const code =
    `const __vrPath = fileURLToPath(globalThis._importMeta_.ROLLUP_FILE_URL_abc123);`;
  const result = repairMangledFileUrlTokens(code, (refId) => {
    assert.equal(refId, "abc123");
    return "native-deadbeef.node";
  });

  assert.ok(result, "returns a replacement when a token is present");
  assert.equal(
    result.code,
    `const __vrPath = fileURLToPath(new URL("native-deadbeef.node", globalThis._importMeta_.url));`,
  );
  assert.equal(result.map, null);
});

test("repairs every token in a chunk, each with its own asset name", () => {
  const code = [
    `const a = globalThis._importMeta_.ROLLUP_FILE_URL_ref1;`,
    `const b = globalThis._importMeta_.ROLLUP_FILE_URL_ref2;`,
  ].join("\n");
  const names: Record<string, string> = {
    ref1: "one-aaa.node",
    ref2: "two-bbb.node",
  };

  const result = repairMangledFileUrlTokens(code, (refId) => names[refId]);

  assert.ok(result);
  assert.match(result.code, /new URL\("one-aaa\.node", globalThis\._importMeta_\.url\)/);
  assert.match(result.code, /new URL\("two-bbb\.node", globalThis\._importMeta_\.url\)/);
  assert.doesNotMatch(result.code, /ROLLUP_FILE_URL_/);
});

test("returns null (no-op) when the chunk has no file-URL token", () => {
  const result = repairMangledFileUrlTokens("const x = 1;", () => {
    throw new Error("must not resolve anything");
  });
  assert.equal(result, null);
});

test("leaves an UNmangled token alone (only the replace-plugin damage is repaired)", () => {
  // A raw `import.meta.ROLLUP_FILE_URL_x` means Nitro's replace plugin did NOT
  // run — Rollup will resolve it natively, and rewriting it would be wrong.
  const code = `const p = import.meta.ROLLUP_FILE_URL_zzz;`;
  const result = repairMangledFileUrlTokens(code, () => "nope.node");

  // A token is present so a result object comes back, but the code is unchanged.
  assert.ok(result);
  assert.equal(result.code, code);
});

// ── nitroRustPlugin ─────────────────────────────────────────────────────────

test("nitroRustPlugin exposes the adapted plugin surface", () => {
  const plugin = nitroRustPlugin();

  assert.equal(plugin.name, "vite-rust:nitro");
  assert.equal(typeof plugin.load, "function");
  assert.equal(typeof plugin.renderChunk, "function");
  assert.equal(typeof plugin.writeBundle, "function");
});

test("load forces the server context (the ssr gate does not fire under raw Rollup)", async () => {
  const plugin = nitroRustPlugin();
  const errors: string[] = [];
  const ctx = {
    error(message: string): never {
      errors.push(message);
      throw new Error(message);
    },
  };

  // A `.rs` id with no enclosing Cargo crate: with the ssr gate forced open the
  // load proceeds PAST the gate and fails on the (later) missing-crate check.
  // Without the forced `{ ssr: true }`, raw Rollup passes no options and the
  // gate would reject with "server-side" — which is exactly the bug this
  // wrapper exists to fix.
  const load = plugin.load as (
    this: typeof ctx,
    id: string,
  ) => Promise<unknown>;
  await assert.rejects(load.call(ctx, "/definitely/not/a/crate/lib.rs?rust"));

  assert.equal(errors.length, 1);
  assert.match(errors[0], /No Cargo\.toml found/);
  assert.doesNotMatch(errors[0], /server-side/);
});

test("load ignores non-rust ids", async () => {
  const plugin = nitroRustPlugin();
  const load = plugin.load as (this: unknown, id: string) => Promise<unknown>;
  assert.equal(await load.call({}, "/some/module.ts"), null);
});

test("renderChunk repairs tokens via the plugin context's getFileName", () => {
  const plugin = nitroRustPlugin();
  const ctx = { getFileName: (refId: string) => `${refId}.node` };
  const renderChunk = plugin.renderChunk as (
    this: typeof ctx,
    code: string,
  ) => { code: string } | null;

  const out = renderChunk.call(
    ctx,
    `globalThis._importMeta_.ROLLUP_FILE_URL_ref9`,
  );
  assert.ok(out);
  assert.equal(out.code, `new URL("ref9.node", globalThis._importMeta_.url)`);

  assert.equal(renderChunk.call(ctx, "no tokens here"), null);
});

test("writeBundle is neutralized (chunk-sibling recovery is dead weight under Nitro)", () => {
  const plugin = nitroRustPlugin();
  const writeBundle = plugin.writeBundle as (
    this: unknown,
    ...args: unknown[]
  ) => void;
  // Must be a silent no-op — no context methods touched, nothing thrown.
  assert.equal(writeBundle.call({}, { dir: "/out" }, {}), undefined);
});

// ── collectAddonShipments / nitroShipAddons ─────────────────────────────────

/** In-memory fs seam: `dirs` maps directory → entries; copies are recorded. */
function fakeShipFs(
  dirs: Record<string, string[]>,
  existingDest: string[] = [],
): ShipFs & { copies: Array<[string, string]>; mkdirs: string[] } {
  const dest = new Set(existingDest);
  const copies: Array<[string, string]> = [];
  const mkdirs: string[] = [];
  return {
    copies,
    mkdirs,
    existsSync: (p) => p in dirs || dest.has(p),
    readdirSync: (p) => dirs[p] ?? [],
    mkdirSync: (p) => {
      mkdirs.push(p);
    },
    copyFileSync: (src, to) => {
      copies.push([src, to]);
      dest.add(to);
    },
  };
}

test("ships every .node addon from the source dir into the destination", () => {
  const fs = fakeShipFs({
    "/build/ssr": ["chunk.mjs", "demo-abc.node", "other-def.node"],
  });

  const result = collectAddonShipments(["/build/ssr"], "/out/server", fs);

  assert.deepEqual(result.copied, ["demo-abc.node", "other-def.node"]);
  assert.deepEqual(result.discovered, ["demo-abc.node", "other-def.node"]);
  assert.deepEqual(fs.copies, [
    ["/build/ssr/demo-abc.node", "/out/server/demo-abc.node"],
    ["/build/ssr/other-def.node", "/out/server/other-def.node"],
  ]);
  assert.deepEqual(fs.mkdirs, ["/out/server"]);
});

test("skips addons already present at the destination (idempotent re-runs)", () => {
  const fs = fakeShipFs(
    { "/build/ssr": ["demo-abc.node"] },
    ["/out/server/demo-abc.node"],
  );

  const result = collectAddonShipments(["/build/ssr"], "/out/server", fs);

  assert.deepEqual(result.copied, []);
  assert.deepEqual(result.discovered, ["demo-abc.node"]);
  assert.deepEqual(fs.copies, []);
});

test("silently skips source directories that do not exist", () => {
  const fs = fakeShipFs({ "/real": ["a.node"] });

  const result = collectAddonShipments(["/missing", "/real"], "/out", fs);

  assert.deepEqual(result.copied, ["a.node"]);
});

test("first source directory wins when two provide the same addon name", () => {
  const fs = fakeShipFs({
    "/first": ["same.node"],
    "/second": ["same.node"],
  });

  const result = collectAddonShipments(["/first", "/second"], "/out", fs);

  assert.deepEqual(result.copied, ["same.node"]);
  assert.deepEqual(result.discovered, ["same.node"]);
  assert.deepEqual(fs.copies, [["/first/same.node", "/out/same.node"]]);
});

test("nitroShipAddons registers a compiled hook that copies into serverDir + to", async () => {
  const fs = fakeShipFs({ [join(process.cwd(), ".vinxi/build/ssr")]: ["demo.node"] });
  const module_ = nitroShipAddons(
    { from: ".vinxi/build/ssr", to: "chunks" },
    fs,
  );

  assert.equal(module_.name, "vite-plugin-native-rust:ship-addons");

  const hooks: Record<string, () => void | Promise<void>> = {};
  module_.setup({
    hooks: {
      hook: (name: string, fn: () => void | Promise<void>) => {
        hooks[name] = fn;
      },
    },
    options: { output: { serverDir: "/out/server" } },
  });

  assert.equal(typeof hooks.compiled, "function");
  await hooks.compiled();

  assert.deepEqual(fs.copies, [
    [join(process.cwd(), ".vinxi/build/ssr/demo.node"), "/out/server/chunks/demo.node"],
  ]);
});

test("nitroShipAddons with required: true fails loudly when nothing ships or pre-exists", async () => {
  const fs = fakeShipFs({});
  const module_ = nitroShipAddons({ from: "/nowhere", required: true }, fs);

  const hooks: Record<string, () => void | Promise<void>> = {};
  module_.setup({
    hooks: { hook: (name, fn) => (hooks[name] = fn) },
    options: { output: { serverDir: "/out/server" } },
  });

  await assert.rejects(
    async () => hooks.compiled(),
    /no compiled \.node addon found/,
  );
});

test("nitroShipAddons with required: true accepts an addon already at the destination", async () => {
  // Idempotency must not turn a healthy re-run into a failure: the addon is
  // present at the destination even though nothing needed copying this time.
  const fs = fakeShipFs({ "/src": ["demo.node"] }, ["/out/server/demo.node"]);
  const module_ = nitroShipAddons({ from: "/src", required: true }, fs);

  const hooks: Record<string, () => void | Promise<void>> = {};
  module_.setup({
    hooks: { hook: (name, fn) => (hooks[name] = fn) },
    options: { output: { serverDir: "/out/server" } },
  });

  await hooks.compiled();
  assert.deepEqual(fs.copies, []);
});

test("nitroShipAddons validates its options at construction time", () => {
  assert.throws(
    () => nitroShipAddons({ from: "" }),
    /`from` must be a non-empty string/,
  );
  assert.throws(
    () => nitroShipAddons({ from: [] }),
    /`from` must be a non-empty string/,
  );
  assert.throws(
    // @ts-expect-error deliberate bad input
    () => nitroShipAddons({ from: "/x", to: 7 }),
    /`to` must be a string/,
  );
  assert.throws(
    // @ts-expect-error deliberate bad input
    () => nitroShipAddons({ from: "/x", required: "yes" }),
    /`required` must be a boolean/,
  );
});

// ── nitroPreserveImportMeta ─────────────────────────────────────────────────

test("nitroPreserveImportMeta returns the identity-replace + es2022 fragment", () => {
  assert.deepEqual(nitroPreserveImportMeta(), {
    replace: { "import.meta.url": "import.meta.url" },
    esbuild: { options: { target: "es2022" } },
  });
});

test("nitroPreserveImportMeta returns a fresh object per call (safe to mutate downstream)", () => {
  const a = nitroPreserveImportMeta();
  const b = nitroPreserveImportMeta();
  assert.notEqual(a, b);
  assert.notEqual(a.replace, b.replace);
  assert.notEqual(a.esbuild, b.esbuild);
});
