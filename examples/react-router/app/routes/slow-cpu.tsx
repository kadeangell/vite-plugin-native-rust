import { Link } from "react-router";

import { heavyHashChain } from "../heavy.server";
import type { Route } from "./+types/slow-cpu";

export function meta() {
  return [{ title: "Slow CPU-bound loader" }];
}

export function loader(_args: Route.LoaderArgs) {
  const start = performance.now();
  // Genuinely CPU-bound synchronous work — blocks the event loop.
  const result = heavyHashChain();
  const elapsedMs = Math.round(performance.now() - start);
  return { result, elapsedMs };
}

export default function SlowCpu({ loaderData }: Route.ComponentProps) {
  const { result, elapsedMs } = loaderData;
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Slow CPU-bound loader</h1>
      <p>
        Hashed a buffer with SHA-256 {result.iterations.toLocaleString()} times
        in <strong>{elapsedMs}ms</strong>.
      </p>
      <p>
        Final digest: <code>{result.digest}</code>
      </p>
      <Link to="/">Back home</Link>
    </main>
  );
}
