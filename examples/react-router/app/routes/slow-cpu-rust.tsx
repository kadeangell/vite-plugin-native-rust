import { Link } from "react-router";

import { heavyHashChainRust } from "../rust-demo.server";
import type { Route } from "./+types/slow-cpu-rust";

export function meta() {
  return [{ title: "Slow CPU-bound loader (Rust)" }];
}

export async function loader(_args: Route.LoaderArgs) {
  const start = performance.now();
  // Same 6M-iteration hash chain as /slow-cpu, but run in Rust on napi-rs's
  // Tokio worker pool — the Node event loop stays responsive while it churns.
  const result = await heavyHashChainRust();
  const elapsedMs = Math.round(performance.now() - start);
  return { result, elapsedMs };
}

export default function SlowCpuRust({ loaderData }: Route.ComponentProps) {
  const { result, elapsedMs } = loaderData;
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Slow CPU-bound loader (Rust)</h1>
      <p>
        Hashed a buffer with SHA-256 {result.iterations.toLocaleString()} times
        in Rust in <strong>{elapsedMs}ms</strong>.
      </p>
      <p>
        Final digest: <code>{result.digest}</code>
      </p>
      <Link to="/">Back home</Link>
    </main>
  );
}
