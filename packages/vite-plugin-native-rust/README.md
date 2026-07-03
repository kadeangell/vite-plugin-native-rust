# vite-plugin-native-rust

> **Experimental (0.0.x).** APIs may change before 0.2.

Import Rust directly in Vite SSR server code. The plugin compiles the enclosing
[napi-rs](https://napi.rs) crate into a native `.node` addon, content-hash
caches it, generates named-export JS that loads the binary at runtime, and
mirrors napi's generated types next to your `.rs` file.

```ts
// vite.config.ts
import { rustPlugin } from "vite-plugin-native-rust";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [rustPlugin()],
});
```

```ts
// something.server.ts — server-only (never reachable from the client bundle)
import { hashChain } from "../native/src/lib.rs";

export const digest = await hashChain(6_000_000);
```

Rust modules are **server-only**: importing one from code that can reach the
client bundle is a build error by design.

## Requirements

- Node.js >= 20
- Vite >= 6 (peer dependency)
- `@napi-rs/cli` >= 3 (peer dependency — you install it)
- A Rust toolchain (`cargo` on `PATH`; install from https://rustup.rs)

## Status

Supported: macOS and Linux, React Router v7/v8 and vanilla Vite SSR. Windows is
not yet supported. See the [monorepo repository](https://github.com/kadeangell/vite-plugin-native-rust)
for the runnable example and full documentation.

## License

MIT © Kade Angell
