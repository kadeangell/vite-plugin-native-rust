import { component$ } from "@builder.io/qwik";
import { routeLoader$ } from "@builder.io/qwik-city";
import { add, sumTo } from "../lib/rust.server";

// routeLoader$ runs exclusively on the server — Qwik's optimizer extracts the
// callback into its own segment and the client build replaces it with a
// reference, so the Rust import below never ships to the browser.
export const useRustData = routeLoader$(async () => {
  const five = add(2, 3); // sync, on the main thread
  const total = await sumTo(1_000); // async, off the event loop
  return { add: five, sumTo: total, runtime: process.version };
});

export default component$(() => {
  const rust = useRustData();
  return (
    <main>
      <h1>Qwik City calling native Rust</h1>
      <p>
        <code>add(2, 3)</code> = <strong id="add">{rust.value.add}</strong>
      </p>
      <p>
        <code>await sumTo(1000)</code> ={" "}
        <strong id="sum-to">{rust.value.sumTo}</strong>
      </p>
      <p>
        Computed server-side per request by a napi-rs addon on{" "}
        <code>{rust.value.runtime}</code>. JSON version at{" "}
        <a href="/rust/">/rust/</a>.
      </p>
    </main>
  );
});
