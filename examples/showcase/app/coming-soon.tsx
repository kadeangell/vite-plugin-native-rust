import { Link } from "react-router";

import type { Demo } from "./demos";

// Placeholder body shared by the four demo routes until their demo agent
// replaces the route file with the live A/B implementation.
export function ComingSoon({ demo }: { demo: Demo }) {
  return (
    <main
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: "44rem",
        margin: "0 auto",
        padding: "2.5rem 1.5rem",
        color: "#1a1a1a",
      }}
    >
      <p style={{ marginBottom: "1.5rem" }}>
        <Link to="/">← Showcase</Link>
      </p>
      <h1 style={{ marginBottom: "0.4rem" }}>{demo.title}</h1>
      <p
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          color: "#7a5b00",
        }}
      >
        {demo.crate}
      </p>
      <p style={{ color: "#555" }}>{demo.blurb}</p>
      <p
        style={{
          marginTop: "2rem",
          padding: "1rem 1.25rem",
          border: "1px dashed #ccc",
          borderRadius: "10px",
          color: "#888",
        }}
      >
        Coming soon — this demo is under construction.
      </p>
    </main>
  );
}
