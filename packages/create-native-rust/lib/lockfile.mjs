import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Try to generate `Cargo.lock` for the freshly scaffolded crate at `dir`.
 *
 * Ships the crate with a lockfile from birth so the Vite plugin's
 * content-hash cache key is stable from the very first build — without one,
 * the first compile creates the lockfile and changes the key, so a
 * multi-pipeline build (e.g. Nuxt on Vercel) recompiles an identical crate
 * (issue #4). `cargo generate-lockfile` only resolves dependency metadata; it
 * compiles nothing.
 *
 * Never throws — a missing or misbehaving toolchain must not fail the
 * scaffold. Returns a fresh status object:
 *   - `{ status: "generated" }`        lockfile written next to Cargo.toml
 *   - `{ status: "skipped-no-cargo" }` cargo is not on the PATH
 *   - `{ status: "failed", detail }`   cargo exists but generation failed
 *
 * @param {string} dir  Absolute crate directory (contains Cargo.toml).
 * @returns {Promise<{status: "generated"} | {status: "skipped-no-cargo"} | {status: "failed", detail: string}>}
 */
export async function tryGenerateLockfile(dir) {
  try {
    await execFileAsync("cargo", ["--version"], { timeout: 30_000 });
  } catch {
    return { status: "skipped-no-cargo" };
  }

  try {
    await execFileAsync(
      "cargo",
      ["generate-lockfile", "--manifest-path", join(dir, "Cargo.toml")],
      { cwd: dir, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
    );
    return { status: "generated" };
  } catch (err) {
    const detail =
      (err && typeof err === "object" && "stderr" in err && err.stderr) ||
      (err instanceof Error ? err.message : String(err));
    return { status: "failed", detail: String(detail).trim() };
  }
}
