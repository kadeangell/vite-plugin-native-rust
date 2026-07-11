import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { directExec, type ExecFn } from "./spawn.ts";

/**
 * Fingerprint of the build toolchain, mixed into the cache key so a `rustc` or
 * `@napi-rs/cli` upgrade invalidates cached binaries (they may differ in ABI or
 * codegen even when the crate source is byte-identical).
 */
export interface ToolchainKey {
  /** `rustc -V` output, or a sentinel when it could not be read. */
  rustc: string;
  /** `@napi-rs/cli` package version, or a sentinel when it could not be read. */
  napiCli: string;
}

// Both values are stable for the process lifetime, so resolve each at most once.
let rustcPromise: Promise<string> | null = null;
const napiVersionByBin = new Map<string, string>();

async function readRustcVersion(exec: ExecFn): Promise<string> {
  try {
    const { stdout } = await exec("rustc", ["-V"]);
    return stdout.trim() || "rustc:unknown";
  } catch {
    return "rustc:unavailable";
  }
}

function readNapiCliVersion(napiBin: string | null): string {
  if (napiBin === null) return "napi-cli:unresolved";
  const cached = napiVersionByBin.get(napiBin);
  if (cached !== undefined) return cached;

  let version = "napi-cli:unknown";
  try {
    // napiBin is `<pkgDir>/<bin>`; the package.json sits at the package root.
    const pkgDir = dirname(dirname(napiBin));
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      version?: string;
    };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      version = pkg.version;
    }
  } catch {
    version = "napi-cli:unavailable";
  }
  napiVersionByBin.set(napiBin, version);
  return version;
}

/**
 * Resolve the toolchain fingerprint, memoized per process. `napiBin` is the
 * resolved `@napi-rs/cli` executable path (see `resolveNapiBin`), or `null` when
 * the CLI could not be resolved yet; its containing package's version is read
 * from disk.
 */
export async function getToolchainKey(
  napiBin: string | null,
  exec: ExecFn = directExec,
): Promise<ToolchainKey> {
  if (!rustcPromise) rustcPromise = readRustcVersion(exec);
  const [rustc] = await Promise.all([rustcPromise]);
  return { rustc, napiCli: readNapiCliVersion(napiBin) };
}

/** Stable string form folded into the content hash. */
export function toolchainKeyString(key: ToolchainKey): string {
  return `rustc=${key.rustc}\0napi-cli=${key.napiCli}`;
}

/** Test-only: reset memoized values so a fresh resolution can be observed. */
export function resetToolchainCacheForTests(): void {
  rustcPromise = null;
  napiVersionByBin.clear();
}
