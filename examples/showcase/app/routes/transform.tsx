import { Form, Link } from "react-router";

import { DEMOS } from "../demos";
import { getSample, SAMPLES } from "../transform-samples.server";
import { runTransformDemo, type DemoRun } from "../transform.server";
import type { Route } from "./+types/transform";

const demo = DEMOS.find((d) => d.path === "/transform")!;

export function meta() {
  return [{ title: `${demo.title} — showcase` }];
}

const MAX_CUSTOM_HTML_BYTES = 256 * 1024;
const DEFAULT_UTM_SOURCE = "vpnr-showcase";

interface RunPayload {
  sampleId: string;
  inputName: string;
  inputHtml: string;
  utmSource: string;
  inlineStyles: boolean;
  sanitize: boolean;
  run: DemoRun | null;
  error: string | null;
}

async function execute(
  sampleId: string,
  customHtml: string,
  utmSource: string,
  inlineStyles: boolean,
  sanitize: boolean,
): Promise<RunPayload> {
  const sample = getSample(sampleId) ?? SAMPLES[0];
  const usingCustom = customHtml.trim() !== "";
  const inputHtml = usingCustom ? customHtml : sample.html;
  const inputName = usingCustom ? "Custom HTML" : sample.name;
  const base = {
    sampleId: sample.id,
    inputName,
    inputHtml,
    utmSource,
    inlineStyles,
    sanitize,
  };
  try {
    const run = await runTransformDemo(inputHtml, { utmSource, inlineStyles, sanitize });
    return { ...base, run, error: null };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown transform error";
    return { ...base, run: null, error: message };
  }
}

export async function loader(_args: Route.LoaderArgs) {
  const payload = await execute(SAMPLES[0].id, "", DEFAULT_UTM_SOURCE, true, true);
  return {
    samples: SAMPLES.map(({ id, name, description }) => ({ id, name, description })),
    payload,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const sampleId = String(form.get("sample") ?? SAMPLES[0].id);
  const customHtml = String(form.get("html") ?? "");
  if (Buffer.byteLength(customHtml) > MAX_CUSTOM_HTML_BYTES) {
    throw new Response("Custom HTML too large (max 256 KB)", { status: 413 });
  }
  const utmSource = String(form.get("utmSource") ?? "").slice(0, 100);
  const inlineStyles = form.get("inlineStyles") === "on";
  const sanitize = form.get("sanitize") === "on";
  return { payload: await execute(sampleId, customHtml, utmSource, inlineStyles, sanitize) };
}

// ---------- presentation ----------

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

const cell: React.CSSProperties = {
  padding: "0.45rem 0.9rem",
  borderBottom: "1px solid #eee",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
const labelCell: React.CSSProperties = { ...cell, textAlign: "left" };

const preStyle: React.CSSProperties = {
  fontFamily: mono,
  fontSize: "0.72rem",
  lineHeight: 1.5,
  background: "#f6f8fa",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "0.75rem",
  overflow: "auto",
  maxHeight: "20rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const statBox: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "0.6rem 0.9rem",
  minWidth: "8rem",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statBox}>
      <div style={{ fontSize: "0.75rem", color: "#888" }}>{label}</div>
      <div style={{ fontFamily: mono, fontSize: "1.05rem" }}>{value}</div>
    </div>
  );
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function ms(value: number): string {
  return value.toFixed(3);
}

export default function Transform({ loaderData, actionData }: Route.ComponentProps) {
  const { samples } = loaderData;
  const payload = actionData?.payload ?? loaderData.payload;
  const { run, error } = payload;

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
      <p style={{ fontFamily: mono, color: "#7a5b00" }}>{demo.crate}</p>
      <p style={{ color: "#555" }}>{demo.blurb}</p>

      <Form method="post" style={{ marginTop: "1.5rem", display: "grid", gap: "0.9rem" }}>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "end" }}>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "#555" }}>Sample email</span>
            <select name="sample" defaultValue={payload.sampleId} style={{ padding: "0.35rem" }}>
              {samples.map((sample) => (
                <option key={sample.id} value={sample.id}>
                  {sample.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.85rem", color: "#555" }}>utm_source</span>
            <input
              name="utmSource"
              defaultValue={payload.utmSource}
              maxLength={100}
              style={{ padding: "0.35rem", fontFamily: mono }}
            />
          </label>
          <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
            <input type="checkbox" name="inlineStyles" defaultChecked={payload.inlineStyles} />
            <span style={{ fontSize: "0.9rem" }}>inline styles</span>
          </label>
          <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
            <input type="checkbox" name="sanitize" defaultChecked={payload.sanitize} />
            <span style={{ fontSize: "0.9rem" }}>sanitize</span>
          </label>
          <button type="submit" style={{ padding: "0.45rem 1.2rem", cursor: "pointer" }}>
            Transform
          </button>
        </div>
        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span style={{ fontSize: "0.85rem", color: "#555" }}>
            …or paste your own HTML (leave empty to use the selected sample)
          </span>
          <textarea
            name="html"
            rows={4}
            placeholder="<div>untrusted email html…</div>"
            style={{ fontFamily: mono, fontSize: "0.78rem", padding: "0.5rem" }}
          />
        </label>
      </Form>

      {error !== null ? (
        <p style={{ marginTop: "1.5rem", color: "#b00020" }}>Transform failed: {error}</p>
      ) : run !== null ? (
        <>
          <section style={{ marginTop: "2rem" }}>
            <h2 style={{ fontSize: "1.15rem" }}>What changed — {payload.inputName}</h2>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
              <Stat label="links UTM-tagged" value={String(run.rust.linksRewritten)} />
              <Stat label="classes inlined" value={String(run.rust.classesInlined)} />
              <Stat label="dangerous nodes stripped" value={String(run.rust.elementsRemoved)} />
              <Stat
                label="bytes in → out"
                value={`${kb(run.rust.bytesIn)} → ${kb(run.rust.bytesOut)}`}
              />
            </div>
          </section>

          <section style={{ marginTop: "2rem" }}>
            <h2 style={{ fontSize: "1.15rem" }}>Per-stage timings (this request)</h2>
            <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "0.5rem" }}>
              <thead>
                <tr>
                  <th style={labelCell}>stage</th>
                  <th style={cell}>Rust (ms)</th>
                  <th style={cell}>JS baseline (ms)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={labelCell}>
                    rewrite — links + inline styles
                    <span style={{ color: "#888" }}>
                      {" "}
                      (lol_html streaming vs cheerio parse/modify/serialize)
                    </span>
                  </td>
                  <td style={cell}>{ms(run.rust.rewriteMs)}</td>
                  <td style={cell}>{ms(run.js.rewriteMs)}</td>
                </tr>
                <tr>
                  <td style={labelCell}>
                    sanitize
                    <span style={{ color: "#888" }}> (ammonia vs sanitize-html)</span>
                  </td>
                  <td style={cell}>{ms(run.rust.sanitizeMs)}</td>
                  <td style={cell}>{ms(run.js.sanitizeMs)}</td>
                </tr>
                <tr>
                  <td style={{ ...labelCell, fontWeight: 600 }}>total</td>
                  <td style={{ ...cell, fontWeight: 600 }}>
                    {ms(run.rust.rewriteMs + run.rust.sanitizeMs)}
                  </td>
                  <td style={{ ...cell, fontWeight: 600 }}>
                    {ms(run.js.rewriteMs + run.js.sanitizeMs)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p style={{ color: "#888", fontSize: "0.85rem", marginTop: "0.4rem" }}>
              Single-shot numbers on a few-KB document — see{" "}
              <Link to="/benchmarks">/benchmarks</Link> for warmed p50/p95. The Rust path also
              runs <em>off</em> the event loop; the cheerio path blocks it.
            </p>
          </section>

          <section style={{ marginTop: "2rem" }}>
            <h2 style={{ fontSize: "1.15rem" }}>Correctness checks</h2>
            <ul style={{ listStyle: "none", padding: 0, marginTop: "0.5rem" }}>
              {run.checks.map((check) => (
                <li key={check.name} style={{ padding: "0.3rem 0" }}>
                  <span style={{ color: check.pass ? "#137333" : "#b00020", fontFamily: mono }}>
                    {check.pass ? "PASS" : "FAIL"}
                  </span>{" "}
                  {check.name}
                  <span style={{ color: "#888" }}> — {check.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          <section style={{ marginTop: "2rem" }}>
            <h2 style={{ fontSize: "1.15rem" }}>Before → after</h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
                gap: "1rem",
                marginTop: "0.5rem",
              }}
            >
              <div>
                <h3 style={{ fontSize: "0.95rem", color: "#555" }}>Input source (untrusted)</h3>
                <pre style={preStyle}>{payload.inputHtml}</pre>
              </div>
              <div>
                <h3 style={{ fontSize: "0.95rem", color: "#555" }}>Output source (Rust)</h3>
                <pre style={preStyle}>{run.rust.html}</pre>
              </div>
            </div>
            <h3 style={{ fontSize: "0.95rem", color: "#555", marginTop: "1rem" }}>
              Rendered output (sandboxed iframe)
            </h3>
            <iframe
              title="Transformed email preview"
              sandbox=""
              srcDoc={run.rust.html}
              style={{
                width: "100%",
                height: "24rem",
                border: "1px solid #e5e7eb",
                borderRadius: "8px",
                background: "#f9fafb",
              }}
            />
          </section>
        </>
      ) : null}
    </main>
  );
}
