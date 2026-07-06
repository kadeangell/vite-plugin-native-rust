import { Title } from "@solidjs/meta";
import { createAsync, query, type RouteDefinition } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import { runRustDemo, type RustDemoResult } from "~/lib/rust";

// `runRustDemo` lives in a module-level "use server" file, so this query runs
// the Rust call on the server: directly during SSR, via RPC on client-side
// navigation. Either way the native addon only ever executes in Node.
const getRustDemo = query(() => runRustDemo(), "rust-demo");

export const route = {
  preload: () => getRustDemo(),
} satisfies RouteDefinition;

export default function Home() {
  const rust = createAsync(() => getRustDemo());
  // Client-initiated RPC: calling the "use server" function from browser code
  // POSTs to /_server and runs the Rust in the server-fns bundle — the other
  // server-side pass vinxi builds.
  const [rpc, setRpc] = createSignal<RustDemoResult | null>(null);
  return (
    <main>
      <Title>SolidStart + Rust</Title>
      <h1>SolidStart calling Rust via vite-plugin-native-rust</h1>
      <Show when={rust()} fallback={<p>Computing…</p>}>
        {(r) => (
          <dl>
            <dt>
              <code>add(2, 3)</code> — sync <code>#[napi]</code> fn
            </dt>
            <dd id="add">{r().add}</dd>
            <dt>
              <code>await sumTo(1000)</code> — async <code>#[napi]</code> fn, off
              the event loop
            </dt>
            <dd id="sum-to">{r().sumTo}</dd>
            <dt>Executed on</dt>
            <dd id="runtime">{r().runtime}</dd>
          </dl>
        )}
      </Show>
      <p>
        <button
          id="rpc-button"
          onClick={async () => setRpc(await runRustDemo())}
        >
          Run again from the browser (server-function RPC)
        </button>{" "}
        <Show when={rpc()}>
          {(r) => (
            <span id="rpc-result">
              → add: {r().add}, sumTo: {r().sumTo} ({r().runtime})
            </span>
          )}
        </Show>
      </p>
      <p>
        JSON version at <a href="/api/rust">/api/rust</a>.
      </p>
    </main>
  );
}
