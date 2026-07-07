// Bench slot for the "images" demo (owned exclusively by that demo).
//
// One fixed workload — the Earthrise sample (1920×1920 JPEG, ~136 KB) to a
// 256px-wide thumbnail at quality 60 — across three rows: Rust→WebP,
// Rust→AVIF, and the pure-JS jimp baseline. jimp emits JPEG because no
// pure-JS WebP/AVIF encoder exists; the label says so. Iteration counts are
// small on purpose: /benchmarks runs live per request and AVIF + jimp are the
// slow rows.
import {
  runJimpThumbnail,
  runRustThumbnail,
  type ThumbParams,
} from "../images-pipeline.server";
import { DEFAULT_SAMPLE_ID } from "../images-samples.server";
import type { BenchSuite } from "../benchmarks.server";
import { timeIt } from "../lib/bench.server";

const BENCH_PARAMS: Omit<ThumbParams, "format"> = {
  sampleId: DEFAULT_SAMPLE_ID,
  width: 256,
  quality: 60,
};

export const suite: BenchSuite | null = {
  id: "images",
  title: "Image thumbnails — image + fast_image_resize + webp/ravif vs jimp",
  run: async () => [
    await timeIt(
      "Rust decode→resize→WebP",
      () => runRustThumbnail({ ...BENCH_PARAMS, format: "webp" }),
      12,
    ),
    await timeIt(
      "Rust decode→resize→AVIF (rav1e speed 6)",
      () => runRustThumbnail({ ...BENCH_PARAMS, format: "avif" }),
      8,
    ),
    await timeIt(
      "jimp decode→resize→JPEG (pure JS has no WebP/AVIF encoder)",
      () => runJimpThumbnail({ ...BENCH_PARAMS, format: "webp" }),
      8,
    ),
  ],
};
