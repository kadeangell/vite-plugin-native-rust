<script setup lang="ts">
import type { RustSsrValues } from "./plugins/rust.server";

// Written during SSR by app/plugins/rust.server.ts (the Vite-side Rust call);
// serialized into the payload, so the client hydrates the same values.
const ssr = useState<RustSsrValues | null>("rust-ssr");

// The Nitro-side Rust call: /api/rust is a server/ route bundled by Nitro's
// own Rollup pass.
const { data: api } = await useFetch("/api/rust");
</script>

<template>
  <main style="font-family: system-ui; max-width: 40rem; margin: 3rem auto">
    <h1>vite-plugin-native-rust × Nuxt</h1>
    <p>
      Both values below come from the same napi-rs crate
      (<code>native/</code>), called server-side on every request:
      <code>add(2, 3)</code> should be <strong>5</strong> and
      <code>await sumTo(1000)</code> should be <strong>500500</strong>.
    </p>

    <h2>Vite layer (SSR plugin: <code>app/plugins/rust.server.ts</code>)</h2>
    <ul v-if="ssr">
      <li>add(2, 3) = <strong data-testid="ssr-add">{{ ssr.add }}</strong></li>
      <li>
        await sumTo(1000) =
        <strong data-testid="ssr-sum">{{ ssr.sumTo }}</strong>
      </li>
      <li>computed at {{ ssr.computedAt }}</li>
    </ul>

    <h2>Nitro layer (API route: <code>server/api/rust.ts</code>)</h2>
    <ul v-if="api">
      <li>add(2, 3) = <strong data-testid="api-add">{{ api.add }}</strong></li>
      <li>
        await sumTo(1000) =
        <strong data-testid="api-sum">{{ api.sumTo }}</strong>
      </li>
      <li>runtime {{ api.runtime }}</li>
    </ul>
    <p>
      Raw JSON: <a href="/api/rust"><code>/api/rust</code></a>
    </p>
  </main>
</template>
