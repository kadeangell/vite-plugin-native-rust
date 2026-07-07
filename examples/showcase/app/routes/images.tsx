import { Form, Link, useNavigation } from "react-router";

import { DEMOS } from "../demos";
import {
  FORMAT_CHOICES,
  QUALITY_CHOICES,
  WIDTH_CHOICES,
  type ThumbParams,
} from "../images-options";
import {
  parseThumbParams,
  runJimpThumbnail,
  runRustThumbnail,
  type ThumbResult,
} from "../images-pipeline.server";
import { SAMPLES } from "../images-samples.server";
import type { Route } from "./+types/images";

const demo = DEMOS.find((d) => d.path === "/images")!;

export function meta() {
  return [{ title: `${demo.title} — showcase` }];
}

/** Serializable slice of a ThumbResult (the raw bytes stay on the server). */
interface ThumbStats {
  engine: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  decodeMs: number;
  resizeMs: number;
  encodeMs: number;
  totalMs: number;
}

const toStats = ({ data: _data, contentType: _ct, ...stats }: ThumbResult): ThumbStats => stats;

export async function loader({ request }: Route.LoaderArgs) {
  const searchParams = new URL(request.url).searchParams;
  const params = parseThumbParams(searchParams);

  const samples = SAMPLES.map((s) => ({
    id: s.id,
    title: s.title,
    sourceUrl: s.sourceUrl,
    license: s.license,
    inputBytes: s.jpeg.length,
  }));

  // Only encode when the form was actually submitted (?sample= present).
  // Encoding both engines on a bare navigation made clicking the /images link
  // hang for seconds with no feedback (user report).
  if (!searchParams.has("sample")) {
    return { params, samples, rust: null, jimp: null };
  }

  // Run the engines back to back (not concurrently) so neither's timings are
  // polluted by the other competing for cores.
  const rust = await runRustThumbnail(params);
  const jimp = await runJimpThumbnail(params);

  return { params, samples, rust: toStats(rust), jimp: toStats(jimp) };
}

function thumbSrc(params: ThumbParams, engine: string): string {
  const query = new URLSearchParams({
    sample: params.sampleId,
    width: String(params.width),
    format: params.format,
    quality: String(params.quality),
    engine,
  });
  return `/images/thumb?${query}`;
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
const ms = (value: number): string => `${value.toFixed(1)} ms`;

const mono: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const statCell: React.CSSProperties = {
  padding: "0.3rem 0.75rem",
  borderBottom: "1px solid #eee",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const statLabel: React.CSSProperties = { ...statCell, textAlign: "left", color: "#555" };

function ResultCard({
  heading,
  sub,
  src,
  stats,
}: {
  heading: string;
  sub: string;
  src: string;
  stats: ThumbStats;
}) {
  return (
    <figure
      style={{
        margin: 0,
        padding: "1rem",
        border: "1px solid #ddd",
        borderRadius: "10px",
        flex: "1 1 20rem",
        minWidth: "18rem",
      }}
    >
      <figcaption>
        <strong>{heading}</strong>
        <div style={{ ...mono, fontSize: "0.85rem", color: "#7a5b00" }}>{sub}</div>
      </figcaption>
      <img
        src={src}
        alt={`${heading} thumbnail output`}
        style={{
          width: "100%",
          height: "auto",
          marginTop: "0.75rem",
          borderRadius: "6px",
          background: "#f4f4f4",
        }}
      />
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "0.75rem" }}>
        <tbody>
          <tr>
            <td style={statLabel}>decode</td>
            <td style={statCell}>{ms(stats.decodeMs)}</td>
          </tr>
          <tr>
            <td style={statLabel}>resize</td>
            <td style={statCell}>{ms(stats.resizeMs)}</td>
          </tr>
          <tr>
            <td style={statLabel}>encode ({stats.format})</td>
            <td style={statCell}>{ms(stats.encodeMs)}</td>
          </tr>
          <tr>
            <td style={{ ...statLabel, fontWeight: 600, color: "#1a1a1a" }}>total</td>
            <td style={{ ...statCell, fontWeight: 600 }}>{ms(stats.totalMs)}</td>
          </tr>
          <tr>
            <td style={statLabel}>output</td>
            <td style={statCell}>
              {stats.width}×{stats.height}, {kb(stats.bytes)}
            </td>
          </tr>
        </tbody>
      </table>
    </figure>
  );
}

const fieldStyle: React.CSSProperties = { display: "grid", gap: "0.25rem" };

export default function Images({ loaderData }: Route.ComponentProps) {
  const { params, samples, rust, jimp } = loaderData;
  const activeSample = samples.find((s) => s.id === params.sampleId)!;
  const encoding = useNavigation().state !== "idle";

  return (
    <main
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: "56rem",
        margin: "0 auto",
        padding: "2.5rem 1.5rem",
        color: "#1a1a1a",
      }}
    >
      <p style={{ marginBottom: "1.5rem" }}>
        <Link to="/">← Showcase</Link>
      </p>
      <h1 style={{ marginBottom: "0.4rem" }}>{demo.title}</h1>
      <p style={{ ...mono, color: "#7a5b00" }}>{demo.crate}</p>
      <p style={{ color: "#555" }}>
        A JPEG goes in as a <code>Buffer</code>; Rust decodes it (<code>image</code>), resizes with
        SIMD (<code>fast_image_resize</code>), encodes WebP (<code>libwebp</code>) or AVIF (
        <code>ravif</code>, rayon across cores) — one <code>await thumbnail(buf, opts)</code> call,
        off the event loop. The pure-JS baseline (jimp) runs the same decode→resize→encode on the
        same input. Both images below are encoded live by this request.
      </p>

      <Form
        method="get"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "end",
          margin: "1.5rem 0",
          padding: "1rem",
          border: "1px solid #ddd",
          borderRadius: "10px",
        }}
      >
        <label style={fieldStyle}>
          <span style={{ fontSize: "0.85rem", color: "#555" }}>Sample photo</span>
          <select name="sample" defaultValue={params.sampleId}>
            {samples.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={{ fontSize: "0.85rem", color: "#555" }}>Width</span>
          <select name="width" defaultValue={params.width}>
            {WIDTH_CHOICES.map((w) => (
              <option key={w} value={w}>
                {w}px
              </option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={{ fontSize: "0.85rem", color: "#555" }}>Format (Rust)</span>
          <select name="format" defaultValue={params.format}>
            {FORMAT_CHOICES.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={{ fontSize: "0.85rem", color: "#555" }}>Quality</span>
          <select name="quality" defaultValue={params.quality}>
            {QUALITY_CHOICES.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">{encoding ? "Encoding…" : "Encode"}</button>
      </Form>

      <p style={{ fontSize: "0.9rem", color: "#555" }}>
        Input: <a href={activeSample.sourceUrl}>{activeSample.title}</a> (
        {kb(activeSample.inputBytes)} JPEG, {activeSample.license.toLowerCase()}).
      </p>

      {rust && jimp ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
          <ResultCard
            heading="Rust — crates/images"
            sub={`image + fast_image_resize + ${params.format === "avif" ? "ravif" : "webp"} → ${params.format.toUpperCase()}`}
            src={thumbSrc(params, "rust")}
            stats={rust}
          />
          <ResultCard
            heading="Pure JS — jimp"
            sub="jimp → JPEG (no WebP/AVIF encoder exists in pure JS)"
            src={thumbSrc(params, "jimp")}
            stats={jimp}
          />
        </div>
      ) : (
        <p style={{ color: "#555", padding: "1.5rem 0" }}>
          Pick a sample and hit <strong>Encode</strong> — both engines run live
          on this server (a couple of seconds for AVIF), so nothing encodes
          until you ask.
        </p>
      )}

      <section style={{ marginTop: "2rem", fontSize: "0.9rem", color: "#555" }}>
        <h2 style={{ fontSize: "1.1rem", color: "#1a1a1a" }}>Fair-comparison notes</h2>
        <ul style={{ lineHeight: 1.6 }}>
          <li>
            jimp is the best <em>pure-JS</em> baseline, but it cannot encode WebP or AVIF at all —
            its column shows JPEG at the same quality setting. That gap is itself the point: modern
            codecs simply aren't available without native (or wasm) code.
          </li>
          <li>
            <code>sharp</code> (libvips) is also native and sits in the same performance class as
            this crate — if <code>sharp</code>'s pipeline does what you need, use it. The pitch here
            is <em>customizability</em>: this whole pipeline is ~170 lines of Rust you own, so you
            can swap the resize filter, tune rav1e, or add watermarking/EXIF logic that libvips'
            API doesn't expose — with the same one-line import.
          </li>
          <li>
            A wasm AVIF row (<code>@jsquash/avif</code>) was considered and dropped: the package
            targets browsers and needs manual wasm-module plumbing to run inside an SSR server
            bundle. Published wasm-vs-native AVIF numbers generally show wasm several times slower;
            we'd rather show no number than an unfair one.
          </li>
          <li>
            Rust timings are measured inside the addon (<code>Instant</code>); jimp timings around
            the equivalent JS calls; totals wrap the full call from JS. AVIF encode uses rav1e
            speed 6.
          </li>
        </ul>
      </section>
    </main>
  );
}
