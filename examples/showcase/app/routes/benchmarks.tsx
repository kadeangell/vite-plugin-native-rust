import { Link, useNavigation } from "react-router";

import { BENCHMARK_SUITES } from "../benchmarks.server";
import type { BenchResult } from "../lib/bench.server";
import type { Route } from "./+types/benchmarks";

export function meta() {
  return [{ title: "Benchmarks — showcase" }];
}

interface SuiteResult {
  id: string;
  title: string;
  rows: BenchResult[];
  error: string | null;
  ran: boolean;
}

export async function loader({ request }: Route.LoaderArgs) {
  // Suites run ON DEMAND (?run=<id> or ?run=all), not on plain navigation:
  // running all four takes 15-45s on a serverless vCPU, which made clicking
  // the /benchmarks link look like a dead navigation (user report).
  const runParam = new URL(request.url).searchParams.get("run");
  const suites: SuiteResult[] = [];
  for (const suite of BENCHMARK_SUITES) {
    const shouldRun = runParam === "all" || runParam === suite.id;
    if (!shouldRun) {
      suites.push({ id: suite.id, title: suite.title, rows: [], error: null, ran: false });
      continue;
    }
    try {
      const rows = await suite.run();
      suites.push({ id: suite.id, title: suite.title, rows, error: null, ran: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      suites.push({ id: suite.id, title: suite.title, rows: [], error: message, ran: true });
    }
  }
  return { suites };
}

const cell: React.CSSProperties = {
  padding: "0.5rem 0.9rem",
  borderBottom: "1px solid #eee",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const labelCell: React.CSSProperties = { ...cell, textAlign: "left" };

export default function Benchmarks({ loaderData }: Route.ComponentProps) {
  const { suites } = loaderData;
  const navigation = useNavigation();
  const pendingRun =
    navigation.state === "loading"
      ? new URLSearchParams(navigation.location.search).get("run")
      : null;
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
      <h1>Benchmarks</h1>
      <p style={{ color: "#555" }}>
        Each demo registers a suite in <code>benchmarks.server.ts</code>; every
        row is measured with the shared <code>timeIt</code> helper (p50 / p95 /
        mean over warmed runs). Numbers are produced live when you run a suite
        — a full run takes seconds to tens of seconds on a serverless vCPU, so
        nothing runs until you ask.
      </p>
      <p>
        <Link to="/benchmarks?run=all">
          {pendingRun === "all" ? "Running all suites…" : "Run all suites"}
        </Link>
      </p>

      {suites.length === 0 ? (
        <p style={{ marginTop: "2rem", color: "#888" }}>
          No benchmark suites registered yet — the demo agents append theirs as
          each demo lands.
        </p>
      ) : (
        suites.map((suite) => (
          <section key={suite.id} style={{ marginTop: "2rem" }}>
            <h2 style={{ fontSize: "1.2rem" }}>{suite.title}</h2>
            {!suite.ran && !suite.error ? (
              <p style={{ color: "#555" }}>
                <Link to={`/benchmarks?run=${suite.id}`}>
                  {pendingRun === suite.id
                    ? "Running… (live measurement, can take a few seconds)"
                    : "Run this suite"}
                </Link>
              </p>
            ) : suite.error ? (
              <p style={{ color: "#b00020" }}>Suite failed: {suite.error}</p>
            ) : (
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={labelCell}>implementation</th>
                    <th style={cell}>p50 (ms)</th>
                    <th style={cell}>p95 (ms)</th>
                    <th style={cell}>mean (ms)</th>
                    <th style={cell}>n</th>
                  </tr>
                </thead>
                <tbody>
                  {suite.rows.map((row) => (
                    <tr key={row.label}>
                      <td style={labelCell}>{row.label}</td>
                      <td style={cell}>{row.p50}</td>
                      <td style={cell}>{row.p95}</td>
                      <td style={cell}>{row.mean}</td>
                      <td style={cell}>{row.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))
      )}
    </main>
  );
}
