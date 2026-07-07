/**
 * Nitro adapter for vite-plugin-native-rust — `vite-plugin-native-rust/nitro`.
 *
 * Nitro-family frameworks (Nuxt, SolidStart v1/vinxi, raw Nitro) re-bundle
 * server code with Nitro's own Rollup pipeline, which breaks the plugin's
 * build shape in four documented ways. This module packages the fixes that
 * every Nitro consumer previously hand-rolled (~40 lines per framework —
 * see examples/nuxt and examples/solidstart in the repo history, and
 * https://github.com/kadeangell/vite-plugin-native-rust/issues/3):
 *
 * 1. **The ssr gate rejects everything under raw Rollup.** The plugin's
 *    `load` hook rejects any load where `options.ssr !== true` — that gate is
 *    what stops a `.rs` import leaking into a browser bundle. Vite passes
 *    `{ ssr }` as `load`'s second argument; raw Rollup passes nothing, so
 *    every load would be rejected as "client-side". Nitro's Rollup pass
 *    builds server-only code by construction (nothing it bundles can reach
 *    the browser), so {@link nitroRustPlugin} forces `ssr: true` — preserving
 *    the gate's intent exactly.
 *
 * 2. **Nitro's `import.meta` shim destroys `ROLLUP_FILE_URL_*` tokens.** In
 *    build mode the plugin references the emitted `.node` addon through
 *    Rollup's `import.meta.ROLLUP_FILE_URL_<ref>` mechanism. Nitro registers
 *    `@rollup/plugin-replace` with `"import.meta." → "globalThis._importMeta_."`
 *    and that replacement runs at *transform* time — before Rollup parses the
 *    module — so Rollup never sees the token and never resolves it. The chunk
 *    would ship a literal `globalThis._importMeta_.ROLLUP_FILE_URL_<ref>`
 *    (undefined at runtime → crash on first request). {@link nitroRustPlugin}'s
 *    `renderChunk` repairs each mangled token to
 *    `new URL("<asset-file-name>", globalThis._importMeta_.url)`: Nitro's
 *    runtime sets `globalThis._importMeta_.url` to the *entry* module's URL,
 *    and Rollup writes the emitted asset at the output root — the entry's own
 *    directory — so the entry-relative asset file name resolves correctly
 *    from every chunk. (A chunk-relative `import.meta.url` rewrite is not an
 *    option: the replace plugin runs again at renderChunk time, after this
 *    plugin, and would re-mangle it.)
 *
 * 3. **Nitro's re-bundle drops addons emitted by an upstream Vite pass.**
 *    When the plugin ran inside a framework's *Vite* build (Nuxt app layer,
 *    vinxi's ssr/server-fns routers), the compiled `.node` lands beside the
 *    Vite output — but Nitro then re-bundles those chunks as plain JS input
 *    and knows nothing about the sibling asset, so it never reaches the final
 *    output. {@link nitroShipAddons} is a Nitro *module* that copies the
 *    addons into the output server directory on Nitro's `compiled` hook. (A
 *    module, not `hooks.compiled` config: a user-level `hooks.compiled`
 *    REPLACES a preset's own compiled hook — the Vercel preset's writes
 *    `config.json`/`.vc-config.json` there — silently breaking deploys.
 *    A module adds its hook via `nitro.hooks.hook()` additively.)
 *
 * 4. **The plugin's chunk-sibling recovery inverts into dead weight.** The
 *    base plugin's `writeBundle` guarantees each addon exists next to every
 *    chunk that references it — correct under Vite/Rollup semantics where
 *    chunks resolve `import.meta.url` against THEMSELVES. Nitro resolves
 *    `globalThis._importMeta_.url` against the server ENTRY, so those
 *    chunk-sibling copies are never read at runtime; they only add spurious
 *    "recovered dropped addon" warnings and ~500 kB of dead weight per
 *    referencing chunk directory (shipped inside the deployed function by
 *    e.g. the Vercel preset). {@link nitroRustPlugin} neutralizes the hook.
 *
 * There is a second integration style that never touches Nitro's Rollup pass:
 * when the plugin runs only in the framework's Vite passes (SolidStart v1),
 * the Vite output already contains the *resolved* loader
 * `new URL("<relpath>", import.meta.url)`. Nitro's re-bundle would still
 * mangle `import.meta.url` (and its esbuild step, targeting es2019, would
 * stub `import.meta` entirely). {@link nitroPreserveImportMeta} returns the
 * config fragment that keeps `import.meta.url` real through both steps;
 * combine it with {@link nitroShipAddons} to place the addon where that
 * chunk-relative loader resolves.
 *
 * > **Nitro version note:** everything here was built and verified against
 * > **Nitro 2.x** (Nuxt 4, SolidStart v1/vinxi, TanStack Start's nitro
 * > plugin). Nitro v3 (Nuxt 5) is a ground-up rewrite — re-validate every
 * > accommodation there before relying on this module; see
 * > https://github.com/kadeangell/vite-plugin-native-rust/issues/3.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { Rollup } from "vite";

import { rustPlugin } from "./index.ts";
import type { RustPluginOptions } from "./options.ts";

const PREFIX = "[vite-plugin-native-rust/nitro]";

// ── Accommodation 2: token repair ───────────────────────────────────────────

/**
 * Matches ONLY the damaged form. A raw `import.meta.ROLLUP_FILE_URL_<ref>`
 * means Nitro's replace plugin did not run on that chunk, Rollup will resolve
 * it natively, and rewriting it would be wrong.
 */
const MANGLED_FILE_URL_TOKEN =
  /globalThis\._importMeta_\.ROLLUP_FILE_URL_(\w+)/g;

/**
 * Repair `import.meta.ROLLUP_FILE_URL_<ref>` tokens that Nitro's
 * `@rollup/plugin-replace` mangled into `globalThis._importMeta_.ROLLUP_FILE_URL_<ref>`
 * before Rollup could resolve them (accommodation 2 above). Each mangled token
 * becomes `new URL("<asset-file-name>", globalThis._importMeta_.url)` — an
 * ENTRY-relative reference, matching where Nitro's runtime points
 * `globalThis._importMeta_.url` and where Rollup writes the emitted asset.
 *
 * Returns `null` when the chunk contains no token (Rollup treats that as
 * "no change"); exported for direct unit testing.
 */
export function repairMangledFileUrlTokens(
  code: string,
  getAssetFileName: (referenceId: string) => string,
): { code: string; map: null } | null {
  if (!code.includes("ROLLUP_FILE_URL_")) return null;
  return {
    code: code.replace(MANGLED_FILE_URL_TOKEN, (_match, referenceId: string) => {
      const assetFileName = getAssetFileName(referenceId);
      return `new URL(${JSON.stringify(assetFileName)}, globalThis._importMeta_.url)`;
    }),
    map: null,
  };
}

// ── Accommodations 1, 2, 4: the Rollup-compatible plugin wrapper ────────────

type LoadHook = (
  this: Rollup.PluginContext,
  id: string,
  options?: { ssr?: boolean },
) => Rollup.LoadResult | Promise<Rollup.LoadResult>;

/**
 * `rustPlugin()` adapted for Nitro's raw Rollup pass — use it in
 * `nitro.rollupConfig.plugins` (Nuxt `server/` directory, raw Nitro apps).
 *
 * Applies accommodations 1 (force the server context in `load`), 2 (repair
 * mangled file-URL tokens in `renderChunk`), and 4 (neutralize the
 * chunk-sibling `writeBundle` recovery) from the module doc above.
 *
 * **Placement is load-bearing:** put this FIRST in
 * `nitro.rollupConfig.plugins`. `enforce: "pre"` is a Vite concept — raw
 * Rollup runs plugins in array order, and this plugin must claim `.rs`
 * specifiers before Nitro's node-resolve tries to parse raw Rust source as
 * JavaScript. (Nitro merges user `rollupConfig.plugins` ahead of its own, so
 * the top-level position works.) The base plugin's Vite-only hooks (`config`,
 * `configResolved`) are silently ignored by Rollup; the plugin root therefore
 * stays `process.cwd()` — correct when the framework build runs from the
 * project directory.
 *
 * > Built against **Nitro 2.x**; Nitro v3 is a rewrite — revalidate first
 * > (https://github.com/kadeangell/vite-plugin-native-rust/issues/3).
 */
export function nitroRustPlugin(options?: RustPluginOptions): Rollup.Plugin {
  const base = rustPlugin(options);
  const baseLoad = base.load as LoadHook;

  return {
    ...(base as unknown as Rollup.Plugin),
    name: "vite-rust:nitro",

    load(this: Rollup.PluginContext, id: string) {
      // Accommodation 1: Nitro's Rollup pass is server-only by construction.
      return baseLoad.call(this, id, { ssr: true });
    },

    renderChunk(this: Rollup.PluginContext, code: string) {
      // Accommodation 2: repair the tokens Nitro's import.meta shim mangled.
      return repairMangledFileUrlTokens(code, (referenceId) =>
        this.getFileName(referenceId),
      );
    },

    // Accommodation 4: the base plugin's post-write safety net assumes chunks
    // resolve the addon relative to THEMSELVES; under Nitro's entry-relative
    // runtime its copies are never read — only warnings and dead weight.
    writeBundle() {},
  };
}

// ── Accommodation 3: ship addons into Nitro's output ────────────────────────

/** Options for {@link nitroShipAddons}. */
export interface NitroShipAddonsOptions {
  /**
   * Directory (or directories) to scan for compiled `.node` addons — the
   * upstream Vite pass's server output. Relative paths resolve against
   * `process.cwd()` at hook time. Examples: `".nuxt/dist/server"` (Nuxt app
   * layer), `".vinxi/build/ssr"` (SolidStart v1). Directories that do not
   * exist are skipped silently.
   */
  from: string | readonly string[];
  /**
   * Destination subdirectory inside Nitro's output server dir
   * (`nitro.options.output.serverDir`). Default `""` — the server root, where
   * the ENTRY-relative references produced by {@link nitroRustPlugin} resolve.
   * Set `"chunks"` when the surviving loader is CHUNK-relative (the
   * {@link nitroPreserveImportMeta} style) and the referencing chunk lands in
   * `chunks/<name>/` one level below.
   */
  to?: string;
  /**
   * Fail the build when no addon is discovered in any `from` directory.
   * Default `false`. Turn it on when the addon is load-bearing for the app —
   * a missing addon then fails the build instead of the deploy's cold start.
   */
  required?: boolean;
}

/** Filesystem seam for {@link collectAddonShipments}; injectable for tests. */
export interface ShipFs {
  existsSync: (path: string) => boolean;
  readdirSync: (path: string) => string[];
  mkdirSync: (path: string) => void;
  copyFileSync: (src: string, dest: string) => void;
}

const defaultShipFs: ShipFs = {
  existsSync,
  readdirSync: (path) => readdirSync(path),
  mkdirSync: (path) => {
    mkdirSync(path, { recursive: true });
  },
  copyFileSync,
};

/** Result of one shipment pass over the source directories. */
export interface ShipResult {
  /** Addon file names copied into the destination this run. */
  copied: readonly string[];
  /** Every addon file name discovered (copied or already at the destination). */
  discovered: readonly string[];
}

/**
 * Scan `fromDirs` for `.node` files and copy each into `destDir` unless an
 * identically named file is already there (idempotent re-runs; the plugin's
 * addon file names are content-hashed, so same name ⇒ same binary). The first
 * source directory providing a given file name wins. Exported for unit tests.
 */
export function collectAddonShipments(
  fromDirs: readonly string[],
  destDir: string,
  fs: ShipFs = defaultShipFs,
): ShipResult {
  const discovered: string[] = [];
  const copied: string[] = [];
  let destEnsured = false;

  for (const dir of fromDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".node") || discovered.includes(file)) continue;
      discovered.push(file);

      const dest = join(destDir, file);
      if (fs.existsSync(dest)) continue;
      if (!destEnsured) {
        fs.mkdirSync(destDir);
        destEnsured = true;
      }
      fs.copyFileSync(join(dir, file), dest);
      copied.push(file);
    }
  }

  return { copied, discovered };
}

/** The structural subset of a Nitro instance this module touches. */
export interface NitroLike {
  hooks: {
    hook: (name: string, fn: () => void | Promise<void>) => void;
  };
  options: { output: { serverDir: string } };
}

/** A Nitro module (`{ name, setup }`) — structural to avoid a nitropack dep. */
export interface NitroModuleLike {
  name: string;
  setup: (nitro: NitroLike) => void;
}

function resolveShipOptions(options: NitroShipAddonsOptions): {
  fromDirs: readonly string[];
  to: string;
  required: boolean;
} {
  const fromList =
    typeof options.from === "string" ? [options.from] : [...(options.from ?? [])];
  if (
    fromList.length === 0 ||
    !fromList.every((dir) => typeof dir === "string" && dir.trim() !== "")
  ) {
    throw new Error(
      `${PREFIX} invalid options: \`from\` must be a non-empty string or a ` +
        "non-empty array of non-empty strings (the directory the upstream " +
        "Vite pass wrote the .node addon to).",
    );
  }
  if (options.to !== undefined && typeof options.to !== "string") {
    throw new Error(`${PREFIX} invalid options: \`to\` must be a string.`);
  }
  if (options.required !== undefined && typeof options.required !== "boolean") {
    throw new Error(`${PREFIX} invalid options: \`required\` must be a boolean.`);
  }
  return {
    fromDirs: fromList,
    to: options.to ?? "",
    required: options.required ?? false,
  };
}

/**
 * A Nitro module that copies compiled `.node` addons from an upstream Vite
 * pass's output into Nitro's final output on the `compiled` hook
 * (accommodation 3 in the module doc). Register it in Nitro `modules` — e.g.
 * `nitro.modules` in `nuxt.config.ts` or `server.modules` in a SolidStart
 * `app.config.ts` — NEVER as a `hooks.compiled` entry, which would *replace*
 * a preset's own compiled hook (the Vercel preset writes its Build Output API
 * metadata there) and silently break the deploy.
 *
 * > Built against **Nitro 2.x**; Nitro v3 is a rewrite — revalidate first
 * > (https://github.com/kadeangell/vite-plugin-native-rust/issues/3).
 *
 * @param fs test seam; omit in real use.
 */
export function nitroShipAddons(
  options: NitroShipAddonsOptions,
  fs: ShipFs = defaultShipFs,
): NitroModuleLike {
  const { fromDirs, to, required } = resolveShipOptions(options);

  return {
    name: "vite-plugin-native-rust:ship-addons",
    setup(nitro: NitroLike) {
      nitro.hooks.hook("compiled", () => {
        const absFromDirs = fromDirs.map((dir) =>
          isAbsolute(dir) ? dir : resolve(process.cwd(), dir),
        );
        const destDir = join(nitro.options.output.serverDir, to);
        const { copied, discovered } = collectAddonShipments(
          absFromDirs,
          destDir,
          fs,
        );

        if (required && discovered.length === 0) {
          throw new Error(
            `${PREFIX} no compiled .node addon found in ` +
              `${absFromDirs.join(", ")} — did the rust plugin run in the ` +
              "upstream Vite pass? (nitroShipAddons was registered with " +
              "`required: true`.)",
          );
        }
        for (const file of copied) {
          process.stderr.write(
            `${PREFIX} shipped addon ${file} → ${destDir}\n`,
          );
        }
      });
    },
  };
}

// ── The preserve-import.meta config fragment (SolidStart/vinxi style) ───────

/** Shape of the fragment returned by {@link nitroPreserveImportMeta}. */
export interface NitroPreserveImportMetaFragment {
  replace: Record<string, string>;
  esbuild: { options: { target: string } };
}

/**
 * Nitro config fragment that keeps `import.meta.url` REAL through Nitro's
 * re-bundle — for the integration style where the rust plugin ran only in the
 * framework's *Vite* passes (SolidStart v1/vinxi) and the chunks Nitro
 * consumes already contain the resolved loader
 * `new URL("<relpath>", import.meta.url)`. Spread it into the Nitro config
 * (`server: { ...nitroPreserveImportMeta(), … }`):
 *
 * - `replace`: Nitro merges user `replace` entries last and
 *   `@rollup/plugin-replace` matches longest-key-first, so the identity
 *   mapping `"import.meta.url" → "import.meta.url"` exempts exactly
 *   `import.meta.url` from Nitro's `import.meta.` → `globalThis._importMeta_.`
 *   stub while leaving every other `import.meta.<x>` stubbed as Nitro intends.
 * - `esbuild.options.target`: Nitro's esbuild step defaults to es2019, where
 *   `import.meta` is "not available" — esbuild would stub it to `{}` and break
 *   the loader the replace exemption just preserved. es2022 keeps it intact
 *   (any Node ≥ 16.11 runtime supports es2022).
 *
 * Scope note: this keeps `import.meta.url` real for the WHOLE server bundle,
 * not just the loader chunk. For a pure-ESM Node function the real value is
 * more correct than Nitro's entry-URL stub — but if other code depends on the
 * stubbed behavior, re-test. Pair with {@link nitroShipAddons} so the addon
 * lands where the chunk-relative loader resolves.
 *
 * > Built against **Nitro 2.x**; Nitro v3 is a rewrite — revalidate first
 * > (https://github.com/kadeangell/vite-plugin-native-rust/issues/3).
 */
export function nitroPreserveImportMeta(): NitroPreserveImportMetaFragment {
  return {
    replace: { "import.meta.url": "import.meta.url" },
    esbuild: { options: { target: "es2022" } },
  };
}
