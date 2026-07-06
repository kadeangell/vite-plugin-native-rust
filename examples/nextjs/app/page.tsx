import { add, sumTo } from "../lib/native.server";

// Compute per-request in the server function instead of at build time, so the
// deployed page actually exercises the native addon inside the Vercel function.
export const dynamic = "force-dynamic";

export default async function Home() {
  // Sync #[napi] export — runs on the main thread, fine for trivial work.
  const addResult = add(2, 3);

  // Async #[napi] export — runs on napi-rs's thread pool, off the Node event
  // loop. This is the shape for heavy CPU-bound work.
  const sumToResult = await sumTo(1000);

  return (
    <main>
      <h1>Rust in a Next.js server component</h1>
      <p>
        Next.js does not run Vite, so <code>vite-plugin-native-rust</code>{" "}
        cannot be used here. This page calls the same napi-rs crate directly.
        See the example README for what the plugin would have automated.
      </p>
      <ul>
        <li>
          <code>add(2, 3)</code> = <strong data-testid="add">{addResult}</strong>
        </li>
        <li>
          <code>await sumTo(1000)</code> ={" "}
          <strong data-testid="sumTo">{sumToResult}</strong>
        </li>
      </ul>
      <p>
        Node {process.version} on {process.platform}-{process.arch}
      </p>
    </main>
  );
}
