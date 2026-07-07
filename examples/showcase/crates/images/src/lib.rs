#![deny(clippy::all)]

use std::time::Instant;

use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
use image::{ColorType, DynamicImage};
use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use rgb::FromSlice;

/// Options object for [`thumbnail`] — the napi "options struct" pattern.
///
/// `#[napi(object)]` maps a plain Rust struct to a plain JS object (by-value,
/// no class wrapper), so the JS call site reads naturally:
/// `thumbnail(buf, { width: 480, format: "webp", quality: 60 })`.
#[napi(object)]
pub struct ThumbOpts {
    /// Target width in pixels (16–2048). Height preserves the aspect ratio.
    pub width: u32,
    /// Output codec. `ts_type` narrows the generated TS to a string union, so
    /// invalid formats are a *compile-time* error in TS and a validated
    /// `InvalidArg` at runtime from JS.
    #[napi(ts_type = "\"webp\" | \"avif\"")]
    pub format: String,
    /// Encoder quality, 1–100 (WebP quality / AVIF quantizer scale).
    pub quality: u32,
}

/// Result object for [`thumbnail`]: the encoded bytes plus an honest
/// per-phase timing breakdown measured inside Rust.
#[napi(object)]
pub struct EncodedImage {
    /// Encoded WebP/AVIF bytes. `Buffer` here becomes a Node `Buffer` without
    /// an intermediate copy into a JS array.
    pub data: Buffer,
    /// Output width in pixels.
    pub width: u32,
    /// Output height in pixels.
    pub height: u32,
    /// Encoded size in bytes (`data.length`, pre-computed for display).
    pub bytes: u32,
    /// Milliseconds spent decoding the input (JPEG/PNG -> RGBA).
    pub decode_ms: f64,
    /// Milliseconds spent in the SIMD Lanczos3 resize.
    pub resize_ms: f64,
    /// Milliseconds spent encoding (WebP or AVIF).
    pub encode_ms: f64,
}

const MIN_WIDTH: u32 = 16;
const MAX_WIDTH: u32 = 2048;
const MIN_QUALITY: u32 = 1;
const MAX_QUALITY: u32 = 100;
/// rav1e speed preset (0 = slowest/best … 10 = fastest). 6 is a sane
/// server-side default; AVIF is still CPU-heavy at this setting.
const AVIF_SPEED: u8 = 6;

fn invalid_arg(message: String) -> Error {
    Error::new(Status::InvalidArg, message)
}

/// Validate options at the boundary — fail fast with a clear message instead
/// of letting a bad value surface as a cryptic encoder error.
fn validate(opts: &ThumbOpts) -> Result<()> {
    if opts.width < MIN_WIDTH || opts.width > MAX_WIDTH {
        return Err(invalid_arg(format!(
            "width must be {MIN_WIDTH}..={MAX_WIDTH}, got {}",
            opts.width
        )));
    }
    if opts.quality < MIN_QUALITY || opts.quality > MAX_QUALITY {
        return Err(invalid_arg(format!(
            "quality must be {MIN_QUALITY}..={MAX_QUALITY}, got {}",
            opts.quality
        )));
    }
    if opts.format != "webp" && opts.format != "avif" {
        return Err(invalid_arg(format!(
            "format must be \"webp\" or \"avif\", got \"{}\"",
            opts.format
        )));
    }
    Ok(())
}

fn ms_since(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Decode -> SIMD resize -> WebP/AVIF encode, entirely off the event loop.
///
/// `async` puts the whole pipeline on napi's worker pool, and `ravif`'s
/// rayon-backed encoder fans the AV1 work across cores from there — the Node
/// event loop stays free for other requests the entire time.
///
/// Buffer in, Buffer out: the input is the raw bytes of a JPEG/PNG file; the
/// result carries the encoded image plus a decode/resize/encode ms breakdown.
#[napi]
pub async fn thumbnail(input: Buffer, opts: ThumbOpts) -> Result<EncodedImage> {
    validate(&opts)?;

    let decode_start = Instant::now();
    let decoded = image::load_from_memory(&input)
        .map_err(|e| invalid_arg(format!("could not decode input image: {e}")))?;
    // Normalize to RGBA8 so resize + both encoders share one pixel layout.
    let src = DynamicImage::ImageRgba8(decoded.into_rgba8());
    let decode_ms = ms_since(decode_start);

    let (dst_width, dst_height) = target_dimensions(src.width(), src.height(), opts.width)?;

    let resize_start = Instant::now();
    let mut dst = DynamicImage::new(dst_width, dst_height, ColorType::Rgba8);
    let mut resizer = Resizer::new();
    let resize_options =
        ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    resizer
        .resize(&src, &mut dst, &resize_options)
        .map_err(|e| Error::from_reason(format!("resize failed: {e}")))?;
    let resize_ms = ms_since(resize_start);

    let rgba = dst.into_rgba8();
    let encode_start = Instant::now();
    let data = match opts.format.as_str() {
        "webp" => encode_webp(rgba.as_raw(), dst_width, dst_height, opts.quality),
        _ => encode_avif(rgba.as_raw(), dst_width, dst_height, opts.quality)?,
    };
    let encode_ms = ms_since(encode_start);

    let bytes = u32::try_from(data.len())
        .map_err(|_| Error::from_reason("encoded image exceeds u32::MAX bytes".to_string()))?;

    Ok(EncodedImage {
        data: data.into(),
        width: dst_width,
        height: dst_height,
        bytes,
        decode_ms,
        resize_ms,
        encode_ms,
    })
}

/// Compute the aspect-preserving output size for a requested width.
fn target_dimensions(src_width: u32, src_height: u32, out_width: u32) -> Result<(u32, u32)> {
    if src_width == 0 || src_height == 0 {
        return Err(invalid_arg("input image has zero dimensions".to_string()));
    }
    let ratio = f64::from(src_height) / f64::from(src_width);
    let out_height = (f64::from(out_width) * ratio).round().max(1.0) as u32;
    Ok((out_width, out_height))
}

fn encode_webp(rgba: &[u8], width: u32, height: u32, quality: u32) -> Vec<u8> {
    let encoder = webp::Encoder::from_rgba(rgba, width, height);
    encoder.encode(quality as f32).to_vec()
}

fn encode_avif(rgba: &[u8], width: u32, height: u32, quality: u32) -> Result<Vec<u8>> {
    let pixels = rgba.as_rgba();
    let img = ravif::Img::new(pixels, width as usize, height as usize);
    let encoded = ravif::Encoder::new()
        .with_quality(quality as f32)
        .with_alpha_quality(quality as f32)
        .with_speed(AVIF_SPEED)
        .encode_rgba(img)
        .map_err(|e| Error::from_reason(format!("AVIF encode failed: {e}")))?;
    Ok(encoded.avif_file)
}
