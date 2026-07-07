// Server-only entry point for the `transform` demo crate, plus the A/B
// orchestration the /transform route calls. The one-line `.rs` import below
// is the whole plugin story: `crates/transform` composes TWO crates.io deps
// (lol_html + ammonia) behind a single async export.

import { transformHtml } from "../crates/transform/src/lib.rs";
import type { TransformResult } from "../crates/transform/src/lib.rs";

import { transformHtmlJs, type JsTransformResult } from "./transform-baseline.server";
import { runChecks, type CorrectnessCheck } from "./transform-checks.server";

export { transformHtml };

export interface DemoOpts {
  utmSource: string;
  inlineStyles: boolean;
  sanitize: boolean;
}

export interface DemoRun {
  rust: TransformResult;
  js: JsTransformResult;
  checks: CorrectnessCheck[];
}

/** Run the same input through the Rust crate and the JS baseline, then
 * verify the output invariants (UTM tagging, inlining, sanitization, and
 * Rust/JS parity). */
export async function runTransformDemo(html: string, opts: DemoOpts): Promise<DemoRun> {
  const rust = await transformHtml(html, opts);
  const js = transformHtmlJs(html, opts);
  const checks = runChecks(rust, js, opts);
  return { rust, js, checks };
}
