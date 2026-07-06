/**
 * Vitest-mode detection and the small load-time decisions that differ under it.
 *
 * Background: vitest runs its own Vite pipeline with its own config, so the
 * plugin has to sit inside *that* pipeline to handle `.rs` imports at all (see
 * docs/testing.md). Once it does, two of the plugin's normal build decisions are
 * wrong for a test runner:
 *
 *  - The client-graph gate (`load` rejects `!ssr`) exists to stop a `.node`
 *    binary leaking toward the browser bundle. Under vitest everything runs in
 *    Node — jsdom/happy-dom only emulate the DOM in-process — so the gate would
 *    reject legitimate test imports (vitest reports `ssr: false` for web-style
 *    environments) while protecting nothing.
 *  - Build-shape codegen (`emitFile` + `ROLLUP_FILE_URL`) needs a real Rollup
 *    bundle write to place the addon. Vitest never writes a bundle, so the
 *    file-URL token resolves to nothing. The dev shape (require the addon from
 *    its absolute cache path) is the only one that works.
 *
 * These helpers are pure so the branch logic is unit-testable without a live
 * Vite/vitest instance.
 */

/**
 * True when the plugin is running inside a vitest pipeline.
 *
 * Two independent signals, either sufficient:
 *  - `process.env.VITEST === "true"` — vitest sets this in the config-loading
 *    process and in every worker. The primary, most reliable signal.
 *  - a resolved Vite config carrying a `test` key — only vitest injects that.
 *
 * Both are set exclusively by vitest, so neither can false-positive in a real
 * `vite build` / `vite dev`.
 */
export function isVitest(
  config?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.VITEST === "true") return true;
  return (
    typeof config === "object" &&
    config !== null &&
    "test" in (config as Record<string, unknown>)
  );
}

/**
 * Whether to skip the client-graph gate. Under vitest the gate is bypassed
 * unconditionally (tests run in Node); otherwise the original rule stands —
 * only server-side (`ssr === true`) loads are allowed through.
 */
export function shouldBypassSsrGate(
  underVitest: boolean,
  ssr: boolean | undefined,
): boolean {
  return underVitest || ssr === true;
}

/**
 * Whether to emit the dev-shape module (require from the absolute cache path)
 * instead of the build-shape (emitFile + ROLLUP_FILE_URL). Dev shape is used in
 * Rollup watch mode and always under vitest, where there is no bundle to emit
 * into.
 */
export function shouldUseDevShape(
  underVitest: boolean,
  watchMode: boolean,
): boolean {
  return underVitest || watchMode;
}

/**
 * Resolve the build profile to a boolean `release`. An explicit `profile`
 * option always wins. Otherwise the default is `debug` (fast compile) in watch
 * mode and under vitest, `release` only for a genuine production build.
 */
export function resolveRelease(
  profile: "debug" | "release" | null,
  watchMode: boolean,
  underVitest: boolean,
): boolean {
  if (profile !== null) return profile === "release";
  return watchMode !== true && !underVitest;
}
