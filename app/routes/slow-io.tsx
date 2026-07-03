import { setTimeout as sleep } from "node:timers/promises";
import { Link } from "react-router";

import type { Route } from "./+types/slow-io";

const FAKE_IO_DELAY_MS = 3000;

export function meta() {
  return [{ title: "Slow IO-bound loader" }];
}

export async function loader(_args: Route.LoaderArgs) {
  const start = performance.now();
  // Simulate a slow IO-bound dependency (DB query, upstream API, etc.).
  await sleep(FAKE_IO_DELAY_MS);
  const elapsedMs = Math.round(performance.now() - start);
  return { elapsedMs };
}

export default function SlowIo({ loaderData }: Route.ComponentProps) {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Slow IO-bound loader</h1>
      <p>
        The loader awaited a fake IO wait and measured{" "}
        <strong>{loaderData.elapsedMs}ms</strong> elapsed.
      </p>
      <Link to="/">Back home</Link>
    </main>
  );
}
