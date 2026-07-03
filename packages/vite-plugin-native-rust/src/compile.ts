import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Resolve the `@napi-rs/cli` executable that drives crate builds. Throws an
 * actionable error (fail fast) when the CLI is not installed.
 */
export function resolveNapiBin(): string {
  let pkgPath: string;
  try {
    pkgPath = require.resolve("@napi-rs/cli/package.json");
  } catch {
    throw new Error(
      "@napi-rs/cli is not installed — run `npm i -D @napi-rs/cli`.",
    );
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relBin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.napi;
  if (!relBin) {
    throw new Error(
      "@napi-rs/cli has no `napi` bin entry — reinstall it (`npm i -D @napi-rs/cli`).",
    );
  }
  return join(dirname(pkgPath), relBin);
}

/**
 * Fail fast with an actionable message when the Rust toolchain is missing,
 * rather than letting a cold napi build error out cryptically.
 */
export async function assertCargoAvailable(): Promise<void> {
  try {
    await execFileAsync("cargo", ["--version"]);
  } catch {
    throw new Error(
      "`cargo` was not found on your PATH — install Rust from https://rustup.rs.",
    );
  }
}

export interface CrateConfig {
  binaryName: string;
  /** True when a package.json was created or augmented for the crate. */
  generatedMessage: string | null;
}

/**
 * napi v3 refuses to build without a `package.json` carrying a `napi.binaryName`
 * field in the crate dir. Ensure one exists (creating or augmenting immutably),
 * and return the binary name that determines the built `<binaryName>.node`.
 *
 * When `allowGenerate` is false, a missing/incomplete `package.json` is a hard
 * error instead of a silent write into the user's crate.
 */
export function ensureCrateBinaryName(
  crateDir: string,
  allowGenerate = true,
): CrateConfig {
  const pkgPath = join(crateDir, "package.json");
  const dirName = basename(crateDir);

  if (!existsSync(pkgPath)) {
    if (!allowGenerate) {
      throw new Error(
        `No package.json in crate "${crateDir}" and generateCratePackageJson ` +
          `is disabled. Create one with { "napi": { "binaryName": "${dirName}" } }, ` +
          "or set generateCratePackageJson: true.",
      );
    }
    const pkg = { name: dirName, napi: { binaryName: dirName } };
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    return {
      binaryName: dirName,
      generatedMessage: `generated ${pkgPath} with napi.binaryName="${dirName}"`,
    };
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    napi?: { binaryName?: string };
  };
  const existing = pkg.napi?.binaryName;
  if (typeof existing === "string" && existing.length > 0) {
    return { binaryName: existing, generatedMessage: null };
  }

  if (!allowGenerate) {
    throw new Error(
      `Crate "${crateDir}" has a package.json without napi.binaryName and ` +
        "generateCratePackageJson is disabled. Add " +
        `{ "napi": { "binaryName": "${dirName}" } } to it, or set ` +
        "generateCratePackageJson: true.",
    );
  }

  const next = { ...pkg, napi: { ...pkg.napi, binaryName: dirName } };
  writeFileSync(pkgPath, `${JSON.stringify(next, null, 2)}\n`);
  return {
    binaryName: dirName,
    generatedMessage: `added napi.binaryName="${dirName}" to ${pkgPath}`,
  };
}

export interface CompileParams {
  napiBin: string;
  crateDir: string;
  binaryName: string;
  release: boolean;
  /** Hashed destination the built `.node` is copied to. */
  cachePath: string;
  /** Extra args appended to `napi build` (from `RustPluginOptions.napiArgs`). */
  napiArgs?: readonly string[];
}

/**
 * Copy `src` to `dest` atomically: write to a per-writer temp file in the same
 * directory, then `renameSync` into place. A concurrent reader (e.g. a second
 * Vite process) never observes a partial file; the temp file is cleaned up if
 * the rename throws, so success never leaves one behind. `tmpTag` scopes the
 * temp name per process (defaults to the pid) so two writers never collide.
 */
export function atomicCopy(
  src: string,
  dest: string,
  tmpTag: string = String(process.pid),
): void {
  const tmp = `${dest}.tmp-${tmpTag}`;
  try {
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Run `napi build` (debug) or `napi build --release` (prod) inside the crate,
 * then copy the resulting `<binaryName>.node` to the hashed cache path. Throws
 * an Error carrying the stderr tail on compile failure — cargo errors are good,
 * so they are surfaced rather than buried.
 */
export async function compileCrate(params: CompileParams): Promise<void> {
  const { napiBin, crateDir, binaryName, release, cachePath, napiArgs = [] } = params;
  const args = ["build"];
  if (release) args.push("--release");
  args.push(...napiArgs);

  try {
    await execFileAsync(process.execPath, [napiBin, ...args], {
      cwd: crateDir,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const detail =
      (err as { stderr?: string }).stderr ||
      (err as { stdout?: string }).stdout ||
      (err as Error).message;
    throw new Error(
      `napi build failed for crate "${crateDir}":\n${tailLines(detail, 40)}`,
    );
  }

  const builtPath = join(crateDir, `${binaryName}.node`);
  if (!existsSync(builtPath)) {
    throw new Error(
      `napi build reported success but produced no addon at "${builtPath}". ` +
        `Check that the crate's package.json "napi.binaryName" is "${binaryName}".`,
    );
  }

  mkdirSync(dirname(cachePath), { recursive: true });
  atomicCopy(builtPath, cachePath);

  // Version the generated .d.ts alongside the binary: on a cache hit the crate's
  // index.d.ts may belong to a different (later-compiled) source revision.
  const builtDts = join(crateDir, "index.d.ts");
  if (existsSync(builtDts)) atomicCopy(builtDts, `${cachePath}.d.ts`);
}

function tailLines(text: string, count: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-count).join("\n");
}
