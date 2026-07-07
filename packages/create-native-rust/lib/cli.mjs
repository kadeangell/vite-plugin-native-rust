import { scaffold } from "./scaffold.mjs";
import { nextSteps } from "./next-steps.mjs";

const USAGE = `Usage: create-native-rust <dir> [--name <binaryName>]

Scaffold a napi-rs crate ready to import from Vite SSR server code with
vite-plugin-native-rust.

Arguments:
  <dir>                 Directory to create the crate in (must be empty or new).

Options:
  --name <binaryName>   Crate/binary name (default: derived from <dir>).
  -h, --help            Show this help.

Example:
  npm create native-rust native -- --name native
`;

/**
 * Parse argv (already sliced past `node script`). Returns a plain,
 * newly-allocated options object; throws a user-facing Error on bad flags.
 */
export function parseArgs(argv) {
  let dir;
  let name;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--name" || arg === "--name=") {
      name = argv[++i];
      if (name === undefined) {
        throw new Error("--name requires a value");
      }
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option "${arg}"`);
    } else if (dir === undefined) {
      dir = arg;
    } else {
      throw new Error(`unexpected extra argument "${arg}"`);
    }
  }

  return { dir, name, help };
}

/**
 * Human-readable note for a scaffold whose lockfile step did not generate a
 * `Cargo.lock`. Returns null when there is nothing to say (it was generated).
 * Exported for tests.
 */
export function lockfileNote(lockfile, displayDir) {
  if (!lockfile || lockfile.status === "generated") return null;
  const remedy =
    `run \`cargo generate-lockfile\` in ${displayDir}/ and commit the ` +
    "Cargo.lock — without it, the first build changes the plugin's cache " +
    "key and multi-step builds compile the crate twice.";
  if (lockfile.status === "skipped-no-cargo") {
    return `note: cargo not found — skipped generating Cargo.lock. Once Rust is installed, ${remedy}`;
  }
  const detail = lockfile.detail ? ` (${lockfile.detail})` : "";
  return `note: \`cargo generate-lockfile\` failed${detail} — the scaffold is still complete. Please ${remedy}`;
}

/**
 * Run the CLI. Returns an exit code; writes to the provided streams instead of
 * touching process directly, so tests can drive it. `generateLockfile` is an
 * injectable pass-through to `scaffold` for tests.
 */
export async function run(
  argv,
  {
    cwd = process.cwd(),
    out = process.stdout,
    err = process.stderr,
    generateLockfile,
  } = {},
) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err.write(`error: ${e.message}\n\n${USAGE}`);
    return 1;
  }

  if (opts.help) {
    out.write(USAGE);
    return 0;
  }

  if (!opts.dir) {
    err.write(`error: missing target directory\n\n${USAGE}`);
    return 1;
  }

  try {
    const result = await scaffold({
      dir: opts.dir,
      name: opts.name,
      cwd,
      ...(generateLockfile ? { generateLockfile } : {}),
    });
    const note = lockfileNote(result.lockfile, opts.dir.replace(/\/+$/, ""));
    if (note) out.write(`${note}\n\n`);
    out.write(`${nextSteps({ displayDir: opts.dir, name: result.name })}\n`);
    return 0;
  } catch (e) {
    err.write(`error: ${e.message}\n`);
    return 1;
  }
}
