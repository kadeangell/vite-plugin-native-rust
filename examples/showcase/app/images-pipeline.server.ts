// Server-only pipeline for the /images demo: the Rust engine (one-line `.rs`
// import of crates/images) and the pure-JS baseline (jimp), behind a shared
// result shape so the route and the bench suite compare them symmetrically.
//
// Query-param validation for both /images and /images/thumb lives here too —
// every value is checked at the boundary and bad input becomes a 400, never a
// crash deep in an encoder.

import { Jimp, JimpMime } from "jimp";

import { thumbnail } from "../crates/images/src/lib.rs";
import {
  FORMAT_CHOICES,
  QUALITY_CHOICES,
  WIDTH_CHOICES,
  type ThumbEngine,
  type ThumbFormat,
  type ThumbParams,
} from "./images-options";
import { DEFAULT_SAMPLE_ID, getSample, SAMPLES } from "./images-samples.server";

export type { ThumbEngine, ThumbFormat, ThumbParams };

export interface ThumbResult {
  engine: ThumbEngine;
  /** Actual output codec ("webp" | "avif" for Rust; always "jpeg" for jimp). */
  format: string;
  contentType: string;
  data: Buffer;
  width: number;
  height: number;
  bytes: number;
  decodeMs: number;
  resizeMs: number;
  encodeMs: number;
  totalMs: number;
}

export const DEFAULT_PARAMS: ThumbParams = {
  sampleId: DEFAULT_SAMPLE_ID,
  width: 480,
  format: "webp",
  quality: 60,
};

function badRequest(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function parseChoice(raw: string | null, choices: readonly number[], fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!choices.includes(value)) {
    throw badRequest(`invalid value "${raw}" — expected one of ${choices.join(", ")}`);
  }
  return value;
}

/**
 * Validate and default the shared thumbnail params. Throws a 400 `Response`
 * (React Router renders it as such) on any out-of-contract value.
 */
export function parseThumbParams(searchParams: URLSearchParams): ThumbParams {
  const sampleId = searchParams.get("sample") ?? DEFAULT_PARAMS.sampleId;
  if (!SAMPLES.some((s) => s.id === sampleId)) {
    throw badRequest(`unknown sample "${sampleId}"`);
  }

  const rawFormat = searchParams.get("format") ?? DEFAULT_PARAMS.format;
  if (!FORMAT_CHOICES.includes(rawFormat as ThumbFormat)) {
    throw badRequest(`invalid format "${rawFormat}" — expected webp or avif`);
  }

  return {
    sampleId,
    width: parseChoice(searchParams.get("width"), WIDTH_CHOICES, DEFAULT_PARAMS.width),
    format: rawFormat as ThumbFormat,
    quality: parseChoice(searchParams.get("quality"), QUALITY_CHOICES, DEFAULT_PARAMS.quality),
  };
}

export function parseEngine(searchParams: URLSearchParams): ThumbEngine {
  const raw = searchParams.get("engine") ?? "rust";
  if (raw !== "rust" && raw !== "jimp") {
    throw badRequest(`invalid engine "${raw}" — expected rust or jimp`);
  }
  return raw;
}

const round = (ms: number): number => Number(ms.toFixed(3));

/**
 * Rust engine: image (decode) + fast_image_resize (SIMD Lanczos3) +
 * webp/ravif (encode), one async napi call, entirely off the event loop.
 * The per-phase ms come from `Instant` timers inside Rust.
 */
export async function runRustThumbnail(params: ThumbParams): Promise<ThumbResult> {
  const sample = getSample(params.sampleId);
  const start = performance.now();
  const result = await thumbnail(sample.jpeg, {
    width: params.width,
    format: params.format,
    quality: params.quality,
  });
  const totalMs = performance.now() - start;
  return {
    engine: "rust",
    format: params.format,
    contentType: `image/${params.format}`,
    data: Buffer.from(result.data),
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    decodeMs: round(result.decodeMs),
    resizeMs: round(result.resizeMs),
    encodeMs: round(result.encodeMs),
    totalMs: round(totalMs),
  };
}

/**
 * Pure-JS baseline: jimp decode -> resize -> encode. jimp has no WebP or AVIF
 * encoder (no pure-JS package does), so its best comparable output is JPEG at
 * the same quality — labelled as such everywhere it is shown. `format` in
 * `params` is therefore ignored here by necessity, not sleight of hand.
 */
export async function runJimpThumbnail(params: ThumbParams): Promise<ThumbResult> {
  const sample = getSample(params.sampleId);

  const decodeStart = performance.now();
  const img = await Jimp.fromBuffer(sample.jpeg);
  const resizeStart = performance.now();
  img.resize({ w: params.width }); // jimp's own API mutates its instance in place
  const encodeStart = performance.now();
  const data = await img.getBuffer(JimpMime.jpeg, { quality: params.quality });
  const end = performance.now();

  return {
    engine: "jimp",
    format: "jpeg",
    contentType: JimpMime.jpeg,
    data: Buffer.from(data),
    width: img.width,
    height: img.height,
    bytes: data.length,
    decodeMs: round(resizeStart - decodeStart),
    resizeMs: round(encodeStart - resizeStart),
    encodeMs: round(end - encodeStart),
    totalMs: round(end - decodeStart),
  };
}
