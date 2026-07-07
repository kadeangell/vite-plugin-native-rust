# crates/images — thumbnail pipeline (image + fast_image_resize + webp + ravif)

The native crate behind the showcase's `/images` demo. One export:

```ts
import { thumbnail } from "../crates/images/src/lib.rs";

const out = await thumbnail(jpegBuffer, { width: 480, format: "avif", quality: 60 });
// out: { data: Buffer, width, height, bytes, decodeMs, resizeMs, encodeMs }
```

Buffer in, Buffer out — decode (`image`), SIMD Lanczos3 resize
(`fast_image_resize`), then WebP (`webp`/libwebp) or AVIF (`ravif`/rav1e,
rayon across cores) encode, all inside one `#[napi] async fn` on napi's
worker pool. Options arrive as a `#[napi(object)]` struct (`ThumbOpts`); the
`format` field uses `#[napi(ts_type = "\"webp\" | \"avif\"")]` so the
generated TypeScript is a string union, with matching runtime validation that
returns an `InvalidArg` error (a plain JS exception on the other side).

## Measured build cost (Apple Silicon, macOS)

- Cold `napi build --release`: **1m 04s wall** (~112s user CPU) — 128 locked
  packages; `ravif`/`rav1e` dominate. The plugin's content-hash cache eats
  this after the first build.
- Addon size: **2.6 MB** (`images.node`, release, LTO + stripped) — orders of
  magnitude below Vercel's 250 MB function limit.

## A note on `sharp`

`sharp` (libvips) is also a native addon and sits in the same performance
class as this crate — if its pipeline does what you need, it is a great
choice and this demo is not trying to beat it. The pitch here is
*customizability*: the whole pipeline is ~170 lines of Rust you own, so you
can swap resize filters, tune rav1e settings, or splice in logic libvips'
API doesn't expose, and it ships through Vite with a one-line import instead
of a prebuilt-binary matrix.

## Sample photos

The demo's bundled photos are NASA works — public domain under 17 U.S.C.
§ 105 — from the official [NASA Image and Video Library](https://images.nasa.gov)
(Earthrise `as08-14-2383`, Apollo 11 `as11-40-5903`, Andromeda `PIA04921`).
Full provenance sits in the header of each `app/images-sample-*.server.ts`
module, where the JPEGs are committed base64-inline.
