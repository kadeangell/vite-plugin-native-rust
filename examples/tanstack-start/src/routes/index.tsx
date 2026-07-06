import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { add, sumTo } from "../server/rust.server";

/**
 * A server function whose handler calls straight into the compiled Rust
 * addon. Start compiles the handler (and the imports only it uses — the
 * `.rs`-backed `rust.server` module above) out of the client bundle; the
 * browser gets an RPC stub that fetches this result over HTTP.
 */
const getRustValues = createServerFn({ method: "GET" }).handler(async () => {
  const start = performance.now();
  const five = add(2, 3); // sync #[napi] fn — runs on the main thread
  const total = await sumTo(1000); // async #[napi] fn — off the event loop
  const ms = performance.now() - start;
  return { add: five, sumTo: total, ms, node: process.version };
});

export const Route = createFileRoute("/")({
  loader: () => getRustValues(),
  component: Home,
});

function Home() {
  const data = Route.useLoaderData();
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>TanStack Start + vite-plugin-native-rust</h1>
      <p>
        The route loader calls a <code>createServerFn</code> whose handler
        imports <code>native/src/lib.rs</code> — compiled to a napi-rs native
        addon by the Vite plugin.
      </p>
      <ul>
        <li>
          <code>add(2, 3)</code> = <strong data-testid="add">{data.add}</strong>
        </li>
        <li>
          <code>await sumTo(1000)</code> ={" "}
          <strong data-testid="sumTo">{data.sumTo}</strong>
        </li>
      </ul>
      <p>
        Rust calls took {data.ms.toFixed(3)} ms on Node {data.node}. JSON
        endpoint: <a href="/api/rust">/api/rust</a>
      </p>
    </main>
  );
}
