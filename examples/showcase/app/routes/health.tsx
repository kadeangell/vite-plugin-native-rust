import { Link } from "react-router";

import { add, sumTo } from "../health.server";
import type { Route } from "./+types/health";

export function meta() {
  return [{ title: "Health — showcase" }];
}

export async function loader(_args: Route.LoaderArgs) {
  // Exercises both export shapes of the multi-crate `health` addon: a sync fn
  // on the main thread and an async fn on napi's worker pool.
  const sum = add(2, 3); // -> 5
  const sumTo1000 = await sumTo(1000); // -> 500500
  return { sum, sumTo1000 };
}

export default function Health({ loaderData }: Route.ComponentProps) {
  const { sum, sumTo1000 } = loaderData;
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
      <h1>Multi-crate health check</h1>
      <p style={{ color: "#555" }}>
        Values from the <code>crates/health</code> native addon — proof that a
        per-demo crate under <code>crates/</code> compiles and imports cleanly.
      </p>
      <ul style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
        <li>
          <code>add(2, 3)</code> = <strong>{sum}</strong>
        </li>
        <li>
          <code>sumTo(1000)</code> = <strong>{sumTo1000}</strong>
        </li>
      </ul>
    </main>
  );
}
