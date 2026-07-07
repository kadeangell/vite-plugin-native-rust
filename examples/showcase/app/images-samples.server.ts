// Sample-photo registry for the /images demo (demo-private, server-only).
//
// All three photos are NASA works — public domain (17 U.S.C. § 105), each
// downloaded from the official NASA Image and Video Library; per-photo
// provenance lives in the header comment of its `images-sample-*.server.ts`
// data module. They are committed base64-inline so the bytes survive every
// bundler / serverless packaging step; this module decodes each once at
// startup into an immutable registry.

import { andromeda } from "./images-sample-andromeda.server";
import { earthrise } from "./images-sample-earthrise.server";
import { moonwalk } from "./images-sample-moonwalk.server";

/** Shape of a committed base64 data module (one per sample photo). */
export interface SampleImageData {
  id: string;
  title: string;
  nasaId: string;
  sourceUrl: string;
  license: string;
  base64: string;
}

/** A decoded, ready-to-use sample photo. */
export interface SampleImage {
  id: string;
  title: string;
  nasaId: string;
  sourceUrl: string;
  license: string;
  /** Raw JPEG file bytes (what a user upload would look like). */
  jpeg: Buffer;
}

function decode(data: SampleImageData): SampleImage {
  const { base64, ...meta } = data;
  return { ...meta, jpeg: Buffer.from(base64, "base64") };
}

export const SAMPLES: readonly SampleImage[] = [earthrise, moonwalk, andromeda].map(decode);

export const DEFAULT_SAMPLE_ID: string = SAMPLES[0].id;

/** Look up a sample by id; unknown ids fail fast (validated at the boundary). */
export function getSample(id: string): SampleImage {
  const sample = SAMPLES.find((s) => s.id === id);
  if (!sample) {
    const known = SAMPLES.map((s) => s.id).join(", ");
    throw new Error(`Unknown sample image "${id}" (known: ${known})`);
  }
  return sample;
}
