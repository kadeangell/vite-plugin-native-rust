import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** An addon this plugin emitted during a build, with its cache source of truth. */
export interface EmittedAddon {
  /** The asset fileName passed to `emitFile`, e.g. `native-<hash>.node`. */
  fileName: string;
  /** Absolute compile-cache path — the source we copy from if a copy is needed. */
  cachePath: string;
}

/** The subset of a written bundle entry we inspect. Structural to avoid a rollup dep. */
export interface BundleEntry {
  type: string;
  fileName: string;
  /** Present on chunks; the rendered module code we scan for addon references. */
  code?: string;
}

/** Injectable filesystem seam so the scan/copy/fail logic is unit-testable. */
export interface OutputFs {
  existsSync: (path: string) => boolean;
  copyFileSync: (src: string, dest: string) => void;
}

const defaultFs: OutputFs = { existsSync, copyFileSync };

/** One recovered placement: an addon copied next to a chunk that referenced it. */
export interface Placement {
  chunk: string;
  addon: string;
  to: string;
}

/**
 * After the bundle is written, guarantee every emitted `.node` this plugin
 * produced actually exists at the sibling path each referencing chunk resolves
 * (`new URL("<fileName>", import.meta.url)` → same directory as the chunk).
 *
 * The healthy path is a no-op: Rollup already wrote the asset beside the chunk,
 * so the `existsSync` check passes. When a post-processing step (e.g. the
 * `@vercel/react-router` preset's per-function repackaging) carries chunk code
 * without the sibling asset, we copy it back from the compile cache. If the
 * cache is also gone and no written copy can be found, we throw — a loud,
 * actionable failure beats the silent zero-exit that ships a server which
 * cold-start-crashes (issue #1).
 *
 * Returns the list of recovered placements (empty when nothing needed copying).
 */
export function ensureAddonsBesideChunks(
  outDir: string,
  bundle: Record<string, BundleEntry>,
  addons: readonly EmittedAddon[],
  fs: OutputFs = defaultFs,
): Placement[] {
  const entries = Object.values(bundle);
  const placements: Placement[] = [];

  for (const addon of addons) {
    const referencing = entries.filter(
      (entry) =>
        entry.type === "chunk" &&
        typeof entry.code === "string" &&
        entry.code.includes(addon.fileName),
    );

    for (const chunk of referencing) {
      const chunkAbs = join(outDir, chunk.fileName);
      const expected = join(dirname(chunkAbs), addon.fileName);
      if (fs.existsSync(expected)) continue;

      const source = resolveCopySource(outDir, bundle, addon, fs);
      if (!source) {
        throw new Error(
          `[vite-plugin-native-rust] the server chunk "${chunk.fileName}" ` +
            `requires the native addon "${addon.fileName}", but it is absent ` +
            `from the build output at "${expected}" and cannot be recovered ` +
            `(the compile cache "${addon.cachePath}" is also gone). The build ` +
            `would ship a server that crashes on cold start — failing instead. ` +
            `Re-run the build to repopulate the cache; if this persists, open ` +
            `an issue at https://github.com/kadeangell/vite-plugin-native-rust/issues.`,
        );
      }
      fs.copyFileSync(source, expected);
      placements.push({ chunk: chunk.fileName, addon: addon.fileName, to: expected });
    }
  }

  return placements;
}

/**
 * Where to copy a missing addon from: the compile cache first (always current),
 * else any copy Rollup did write elsewhere in the output (its bundle key ends
 * with the addon fileName). Null when neither exists.
 */
function resolveCopySource(
  outDir: string,
  bundle: Record<string, BundleEntry>,
  addon: EmittedAddon,
  fs: OutputFs,
): string | null {
  if (fs.existsSync(addon.cachePath)) return addon.cachePath;

  for (const entry of Object.values(bundle)) {
    if (entry.type !== "asset") continue;
    if (entry.fileName !== addon.fileName && !entry.fileName.endsWith(`/${addon.fileName}`)) {
      continue;
    }
    const written = join(outDir, entry.fileName);
    if (fs.existsSync(written)) return written;
  }
  return null;
}
