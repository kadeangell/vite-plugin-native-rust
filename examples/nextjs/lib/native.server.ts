/**
 * Server-only loader for the napi-rs addon in ./native.
 *
 * Why not `import { add } from "nextdemo"`? `nextdemo` is a local `file:`
 * dependency, so npm installs it as a symlink whose real path lives outside
 * `node_modules`. Next.js only honors `serverExternalPackages` for packages
 * that actually resolve inside `node_modules`, so Turbopack bundles the napi
 * loader instead of leaving it external — and the loader's relative
 * `require("./nextdemo.<platform>.node")` then breaks inside the compiled
 * chunk (verified: "Cannot find native binding" at module evaluation).
 *
 * Instead we bypass the bundler entirely: a `createRequire` require with a
 * runtime-computed absolute path is opaque to Turbopack, so the napi loader
 * and the `.node` binary are loaded by plain Node at runtime. The files reach
 * the serverless filesystem via `outputFileTracingIncludes` in next.config.ts.
 *
 * This whole file is what vite-plugin-native-rust generates for you on Vite.
 */
import { existsSync } from "node:fs";
import path from "node:path";

// Type-only import: erased at compile time, so it never touches the bundler.
type NativeBinding = typeof import("nextdemo");

const LOADER_RELATIVE_PATH = path.join("native", "index.js");

function resolveNativeLoader(): string {
  const candidates = [
    // next dev / next start / Vercel when the function cwd is the app root.
    path.join(process.cwd(), LOADER_RELATIVE_PATH),
    // Vercel monorepo layouts where the function cwd is the repo root.
    path.join(process.cwd(), "examples", "nextjs", LOADER_RELATIVE_PATH),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Could not locate the compiled Rust addon loader. Tried:\n` +
        candidates.map((c) => `  - ${c}`).join("\n") +
        `\nRun \`npm run build:native\` first (it compiles the crate with ` +
        `\`napi build --release --platform\`).`,
    );
  }
  return found;
}

// Obtain a real Node `require` in a way no bundler can statically track.
// Turbopack recognizes `createRequire` imported from "node:module" and swaps
// the returned function for a shim that rejects dynamic arguments ("Cannot
// find module as expression is too dynamic"), so we go through
// `process.getBuiltinModule` (Node >= 20.16) instead.
const { createRequire } = process.getBuiltinModule("node:module");
const nativeRequire = createRequire(process.cwd() + path.sep);
const native = nativeRequire(resolveNativeLoader()) as NativeBinding;

export const add: NativeBinding["add"] = native.add;
export const sumTo: NativeBinding["sumTo"] = native.sumTo;
