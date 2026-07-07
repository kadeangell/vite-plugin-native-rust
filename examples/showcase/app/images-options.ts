// Client-safe option contract for the /images demo: the parameter types and
// the allowed form choices, shared by the route component (rendered in the
// browser) and the server-only pipeline. Deliberately NOT a `.server` module
// and free of Buffers / `.rs` imports — React Router only strips server code
// from loader/action, so anything the component renders must live here.

export type ThumbFormat = "webp" | "avif";
export type ThumbEngine = "rust" | "jimp";

export interface ThumbParams {
  sampleId: string;
  width: number;
  format: ThumbFormat;
  quality: number;
}

export const WIDTH_CHOICES: readonly number[] = [240, 480, 960];
export const QUALITY_CHOICES: readonly number[] = [40, 60, 80];
export const FORMAT_CHOICES: readonly ThumbFormat[] = ["webp", "avif"];
