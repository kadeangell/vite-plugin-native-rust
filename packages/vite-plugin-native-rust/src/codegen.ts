import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A named export of the addon, plus whether it is callable. */
export interface AddonExport {
  key: string;
  /** `true` for napi functions (the common case) → lazy call-site wrappers. */
  isFunction: boolean;
}

/**
 * Load the freshly built addon in the plugin process (same platform, ground
 * truth) and return the exported keys that are valid JS identifiers, tagged
 * with whether each is callable. napi lowercases snake_case to camelCase, so
 * these already match the generated `.d.ts` names.
 */
export function enumerateExports(nodePath: string): AddonExport[] {
  // Hashed paths are unique per source revision, but drop any stale cache entry
  // defensively so a rebuilt addon at the same path is re-read.
  delete require.cache[nodePath];
  const addon = require(nodePath) as Record<string, unknown>;
  return Object.keys(addon)
    .filter((key) => VALID_IDENTIFIER.test(key))
    .map((key) => ({ key, isFunction: typeof addon[key] === "function" }));
}

/**
 * Dev module shape: require the addon straight from its absolute cache path.
 * Vite/Rollup do not trace `createRequire`-created functions, so the binary is
 * left out of the bundle. Dev loads eagerly — the cache path is written before
 * this module ever runs, so there is nothing to guard against.
 */
export function devModuleSource(cachePath: string, exports: AddonExport[]): string {
  const lines = [
    `import { createRequire } from "node:module";`,
    `const require = createRequire(import.meta.url);`,
    `const addon = require(${JSON.stringify(cachePath)});`,
    ...exports.map((e) => `export const ${e.key} = addon.${e.key};`),
  ];
  return `${lines.join("\n")}\n`;
}

const TROUBLESHOOTING_URL =
  "https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/troubleshooting.md";

/**
 * The lazy loader shared by every build-mode module: resolves the addon path
 * from Rollup's file-URL token (relative to whichever chunk it lands in) and
 * requires it on first use, memoizing the result. A missing binary throws an
 * actionable error *at the point of use* — not at module init — so a consumer's
 * try/catch can catch it instead of the whole serverless function cold-starting
 * into an uncatchable crash (issue #1).
 */
function loaderPreamble(refId: string): string[] {
  return [
    `import { createRequire } from "node:module";`,
    `import { fileURLToPath } from "node:url";`,
    `const require = createRequire(import.meta.url);`,
    `const __vrPath = fileURLToPath(import.meta.ROLLUP_FILE_URL_${refId});`,
    `let __vrAddon;`,
    `function __vrLoad() {`,
    `  if (__vrAddon) return __vrAddon;`,
    `  try {`,
    `    __vrAddon = require(__vrPath);`,
    `  } catch (err) {`,
    `    throw new Error(`,
    `      "[vite-plugin-native-rust] the native addon was not found next to " +`,
    `        "the server bundle (expected \\"" + __vrPath + "\\"). The compiled " +`,
    `        ".node was not shipped with this build output — see " +`,
    `        ${JSON.stringify(TROUBLESHOOTING_URL)} + ". Original error: " +`,
    `        (err && err.message ? err.message : String(err)),`,
    `      { cause: err },`,
    `    );`,
    `  }`,
    `  return __vrAddon;`,
    `}`,
  ];
}

/**
 * Build module shape: reference the emitted asset via Rollup's file-URL token
 * so the require path is relative to whichever server chunk it lands in.
 *
 * Function exports become call-site wrappers that load the addon on first
 * invocation (preserving async return values — the wrapper returns the
 * underlying call's result). Non-function exports (rare for napi) load eagerly,
 * but through the same guarded loader so a missing binary still yields the
 * actionable error rather than a bare `Cannot find module`.
 */
export function buildModuleSource(refId: string, exports: AddonExport[]): string {
  const exportLines = exports.map((e) =>
    e.isFunction
      ? `export const ${e.key} = (...args) => __vrLoad().${e.key}(...args);`
      : `export const ${e.key} = __vrLoad().${e.key};`,
  );
  const lines = [...loaderPreamble(refId), ...exportLines];
  return `${lines.join("\n")}\n`;
}

/**
 * Copy the crate's generated `index.d.ts` to `<anchor>.d.rs.ts` next to the
 * imported `.rs` file so `allowArbitraryExtensions` resolves real types. Skips
 * the write when content is unchanged to avoid churning the file watcher.
 * Returns the written path, or null when nothing changed / no `.d.ts` exists.
 */
export function syncTypeDeclaration(
  generatedDtsPath: string,
  anchorDtsPath: string,
): string | null {
  if (!existsSync(generatedDtsPath)) return null;

  const content = readFileSync(generatedDtsPath, "utf8");
  const existing = existsSync(anchorDtsPath)
    ? readFileSync(anchorDtsPath, "utf8")
    : null;
  if (existing === content) return null;

  writeFileSync(anchorDtsPath, content);
  return anchorDtsPath;
}

/**
 * Ensure the root tsconfig enables `allowArbitraryExtensions` so tsc can resolve
 * `./lib.rs` types from a sibling `.d.rs.ts`. No-op when the option is already
 * present or the tsconfig cannot be parsed as plain JSON (avoid clobbering JSONC).
 */
export function ensureTsconfigOption(root: string): void {
  const tsconfigPath = join(root, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return;

  const raw = readFileSync(tsconfigPath, "utf8");
  if (/"allowArbitraryExtensions"\s*:/.test(raw)) return;

  let parsed: { compilerOptions?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const next = {
    ...parsed,
    compilerOptions: {
      ...(parsed.compilerOptions ?? {}),
      allowArbitraryExtensions: true,
    },
  };
  writeFileSync(tsconfigPath, `${JSON.stringify(next, null, 2)}\n`);
}
