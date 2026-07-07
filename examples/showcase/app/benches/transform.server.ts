// Bench slot for the "transform" demo: Rust (lol_html + ammonia) vs the JS
// baseline (cheerio + sanitize-html), both doing the identical three
// transforms (UTM links, class → style inlining, sanitize) on the largest
// bundled email sample. Small iteration count — this runs live per request
// on /benchmarks.
import { timeIt } from "../lib/bench.server";
import { LARGEST_SAMPLE } from "../transform-samples.server";
import { transformHtmlJs } from "../transform-baseline.server";
import { transformHtml } from "../transform.server";
import type { BenchSuite } from "../benchmarks.server";

const OPTS = { utmSource: "vpnr-showcase", inlineStyles: true, sanitize: true };
const ITERATIONS = 15;

export const suite: BenchSuite | null = {
  id: "transform",
  title: `HTML transform — lol_html + ammonia vs cheerio + sanitize-html (${(
    Buffer.byteLength(LARGEST_SAMPLE.html) / 1024
  ).toFixed(1)} KB email)`,
  run: async () => [
    await timeIt(
      "Rust — lol_html streaming rewrite + ammonia sanitize",
      () => transformHtml(LARGEST_SAMPLE.html, OPTS),
      ITERATIONS,
    ),
    await timeIt(
      "JS — cheerio rewrite + sanitize-html",
      () => transformHtmlJs(LARGEST_SAMPLE.html, OPTS),
      ITERATIONS,
    ),
  ],
};
