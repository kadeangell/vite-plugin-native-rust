import { Link } from "react-router";

import { DEMOS } from "../demos";

export function meta() {
  return [
    { title: "vite-plugin-native-rust — showcase" },
    {
      name: "description",
      content:
        "Four server-side demos where the Rust crate ecosystem does something JS can't, each imported into a loader with one line.",
    },
  ];
}

const page: React.CSSProperties = {
  fontFamily: "system-ui, -apple-system, sans-serif",
  maxWidth: "68rem",
  margin: "0 auto",
  padding: "2.5rem 1.5rem 4rem",
  color: "#1a1a1a",
  lineHeight: 1.5,
};

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))",
  gap: "1rem",
  marginTop: "2rem",
};

const card: React.CSSProperties = {
  display: "block",
  padding: "1.25rem 1.4rem",
  border: "1px solid #e3e3e3",
  borderRadius: "12px",
  textDecoration: "none",
  color: "inherit",
  background: "#fafafa",
};

const crateTag: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.8rem",
  color: "#7a5b00",
  background: "#fdf3d7",
  padding: "0.1rem 0.45rem",
  borderRadius: "6px",
};

export default function Home() {
  return (
    <main style={page}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>
        vite-plugin-native-rust — showcase
      </h1>
      <p style={{ fontSize: "1.1rem", color: "#444", maxWidth: "44rem" }}>
        Four server-side tasks a Vite app would actually ship, each one a real
        crates.io dependency imported into a loader with one line — and a live
        A/B against the best JS baseline.
      </p>

      <section style={grid}>
        {DEMOS.map((demo) => (
          <Link key={demo.path} to={demo.path} style={card}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "0.6rem",
                marginBottom: "0.5rem",
              }}
            >
              <h2 style={{ fontSize: "1.15rem", margin: 0 }}>{demo.title}</h2>
              <span style={crateTag}>{demo.crate}</span>
            </div>
            <p style={{ margin: 0, color: "#555", fontSize: "0.95rem" }}>
              {demo.blurb}
            </p>
          </Link>
        ))}
      </section>

      <footer
        style={{
          marginTop: "2.5rem",
          paddingTop: "1.5rem",
          borderTop: "1px solid #eee",
          display: "flex",
          gap: "1.5rem",
          fontSize: "0.95rem",
        }}
      >
        <Link to="/benchmarks">Benchmarks →</Link>
        <Link to="/health">Multi-crate health check →</Link>
      </footer>
    </main>
  );
}
