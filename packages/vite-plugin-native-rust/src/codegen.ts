import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Load the freshly built addon in the plugin process (same platform, ground
 * truth) and return the exported keys that are valid JS identifiers. napi
 * lowercases snake_case to camelCase, so these already match the generated
 * `.d.ts` names.
 */
export function enumerateExports(nodePath: string): string[] {
  // Hashed paths are unique per source revision, but drop any stale cache entry
  // defensively so a rebuilt addon at the same path is re-read.
  delete require.cache[nodePath];
  const addon = require(nodePath) as Record<string, unknown>;
  return Object.keys(addon).filter((key) => VALID_IDENTIFIER.test(key));
}

function exportLines(keys: string[]): string {
  return keys.map((key) => `export const ${key} = addon.${key};`).join("\n");
}

/**
 * Dev module shape: require the addon straight from its absolute cache path.
 * Vite/Rollup do not trace `createRequire`-created functions, so the binary is
 * left out of the bundle.
 */
export function devModuleSource(cachePath: string, keys: string[]): string {
  return `${[
    `import { createRequire } from "node:module";`,
    `const require = createRequire(import.meta.url);`,
    `const addon = require(${JSON.stringify(cachePath)});`,
    exportLines(keys),
  ].join("\n")}\n`;
}

/**
 * Build module shape: reference the emitted asset via Rollup's file-URL token
 * so the require path is relative to whichever server chunk it lands in.
 */
export function buildModuleSource(refId: string, keys: string[]): string {
  return `${[
    `import { createRequire } from "node:module";`,
    `import { fileURLToPath } from "node:url";`,
    `const require = createRequire(import.meta.url);`,
    `const addon = require(fileURLToPath(import.meta.ROLLUP_FILE_URL_${refId}));`,
    exportLines(keys),
  ].join("\n")}\n`;
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
