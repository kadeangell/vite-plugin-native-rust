/**
 * Public options for {@link rustPlugin}. Every field is optional; the defaults
 * reproduce the plugin's behavior with no arguments, so `rustPlugin()` and
 * `rustPlugin({})` are identical.
 */
export interface RustPluginOptions {
  /**
   * Directory the compiled `.node` addons and versioned `.d.ts` are cached in.
   * Relative paths resolve against the Vite root. Defaults to
   * `node_modules/.cache/vite-rust` under the Vite root.
   */
  cacheDir?: string;
  /**
   * Force a build profile. Omit for the default: `debug` in dev/watch mode,
   * `release` for production builds.
   */
  profile?: "debug" | "release";
  /** Extra arguments appended to the `napi build` invocation. */
  napiArgs?: string[];
  /**
   * When a crate has no `package.json` (or one without `napi.binaryName`),
   * write one so napi can build. `false` turns that into an actionable error
   * instead of mutating the user's crate. Default `true`.
   */
  generateCratePackageJson?: boolean;
  /**
   * Mirror napi's generated types to a `.d.rs.ts` beside the imported `.rs`.
   * Default `true`; `false` skips all `.d.rs.ts` writes.
   */
  emitTypes?: boolean;
  /**
   * `'info'` (default) prints the compile-progress line and type-write logs.
   * `'silent'` suppresses them; warnings and errors are always shown.
   */
  logLevel?: "silent" | "info";
  /**
   * Pre-compile known crates when the dev server starts, so a cold cargo
   * build races the developer's first request instead of blocking inside it
   * (some dev servers time out module fetches at ~60s and cache the failure).
   * `true` (default) pre-warms crates remembered from previous sessions via a
   * small manifest in `cacheDir`. An array adds explicit anchors — a `.rs`
   * file or crate dir, resolved against the Vite root — for first-ever runs
   * where no manifest exists yet. `false` disables pre-warming.
   */
  prewarm?: boolean | string[];
}

/** Options after validation and default-filling. */
export interface ResolvedOptions {
  /** Raw cacheDir as given (may be relative); resolved against root later. */
  cacheDir: string | null;
  /** `null` means auto (debug in watch, release in build). */
  profile: "debug" | "release" | null;
  napiArgs: readonly string[];
  generateCratePackageJson: boolean;
  emitTypes: boolean;
  logLevel: "silent" | "info";
  /**
   * `false` = disabled. An array = enabled; its entries are the explicit
   * anchors to pre-warm in addition to the cache-dir manifest (`[]` — the
   * default, from `true`/absent — means manifest-only).
   */
  prewarm: false | readonly string[];
}

const PREFIX = "[vite-plugin-native-rust]";

function fail(message: string): never {
  throw new Error(`${PREFIX} invalid options: ${message}`);
}

/**
 * Validate raw user options at plugin-construction time (fail fast with a clear
 * message) and fold in defaults. Unknown/extra keys are ignored rather than
 * rejected, so a newer consumer passing a future option to an older plugin does
 * not hard-crash.
 */
export function resolveOptions(options: RustPluginOptions = {}): ResolvedOptions {
  if (options === null || typeof options !== "object") {
    fail("expected an options object.");
  }

  const {
    cacheDir,
    profile,
    napiArgs,
    generateCratePackageJson,
    emitTypes,
    logLevel,
    prewarm,
  } = options;

  if (cacheDir !== undefined) {
    if (typeof cacheDir !== "string" || cacheDir.trim() === "") {
      fail("`cacheDir` must be a non-empty string.");
    }
  }

  if (profile !== undefined && profile !== "debug" && profile !== "release") {
    fail(`\`profile\` must be "debug" or "release", got ${JSON.stringify(profile)}.`);
  }

  if (napiArgs !== undefined) {
    if (!Array.isArray(napiArgs) || !napiArgs.every((a) => typeof a === "string")) {
      fail("`napiArgs` must be an array of strings.");
    }
  }

  if (
    generateCratePackageJson !== undefined &&
    typeof generateCratePackageJson !== "boolean"
  ) {
    fail("`generateCratePackageJson` must be a boolean.");
  }

  if (emitTypes !== undefined && typeof emitTypes !== "boolean") {
    fail("`emitTypes` must be a boolean.");
  }

  if (logLevel !== undefined && logLevel !== "silent" && logLevel !== "info") {
    fail(`\`logLevel\` must be "silent" or "info", got ${JSON.stringify(logLevel)}.`);
  }

  if (prewarm !== undefined && typeof prewarm !== "boolean") {
    const validArray =
      Array.isArray(prewarm) &&
      prewarm.every((entry) => typeof entry === "string" && entry.trim() !== "");
    if (!validArray) {
      fail(
        "`prewarm` must be a boolean or an array of non-empty path strings " +
          "(a `.rs` file or crate dir).",
      );
    }
  }

  return {
    cacheDir: cacheDir ?? null,
    profile: profile ?? null,
    napiArgs: napiArgs ? [...napiArgs] : [],
    generateCratePackageJson: generateCratePackageJson ?? true,
    emitTypes: emitTypes ?? true,
    logLevel: logLevel ?? "info",
    prewarm: prewarm === false ? false : Array.isArray(prewarm) ? [...prewarm] : [],
  };
}
