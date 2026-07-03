import { Link } from "react-router";

import { add, hashChain } from "../rust-demo.server";
import type { Route } from "./+types/rust";

const ITERATIONS = 700_000;

export function meta() {
  return [{ title: "Rust native loader" }];
}

export async function loader(_args: Route.LoaderArgs) {
  const start = performance.now();
  // Runs on napi-rs's Tokio worker pool — the Node event loop stays responsive.
  const digest = await hashChain(ITERATIONS);
  const elapsedMs = Math.round(performance.now() - start);
  const sum = add(2, 3);
  return { digest, elapsedMs, iterations: ITERATIONS, sum };
}

export default function Rust({ loaderData }: Route.ComponentProps) {
  const { digest, elapsedMs, iterations, sum } = loaderData;
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Rust native loader</h1>
      <p>
        Hashed a buffer with SHA-256 {iterations.toLocaleString()} times in Rust
        in <strong>{elapsedMs}ms</strong>.
      </p>
      <p>
        Final digest: <code>{digest}</code>
      </p>
      <p>
        <code>add(2, 3) = {sum}</code>
      </p>
      <Link to="/">Back home</Link>
    </main>
  );
}
