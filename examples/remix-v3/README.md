# Remix v3 + native Rust (napi-rs) — without the Vite plugin

Live: **https://vpnr-example-remix-v3.vercel.app** (`/` renders the values,
[`/api/rust`](https://vpnr-example-remix-v3.vercel.app/api/rust) returns
`{"add":5,"sumTo":500500,"n":1000}`).

## The finding first: `vite-plugin-native-rust` cannot be used with Remix 3

Remix v3 (`remix@3.0.0-beta.x`, the ground-up reboot announced in
["Wake up, Remix!"](https://remix.run/blog/wake-up-remix) and shipped as a
[beta preview](https://remix.run/blog/remix-3-beta-preview) in April 2026) is
**not a Vite framework**. It has no bundler and no build step at all — its
"Religiously Runtime" principle means apps run directly from TS/JSX source via
a Node module loader:

```jsonc
// the scaffold's scripts — note: no `build`, no vite
"dev":   "NODE_ENV=development node --watch --import remix/node-tsx server.ts",
"start": "NODE_ENV=production node --import remix/node-tsx server.ts"
```

There is no Vite pipeline for `rustPlugin()` to sit in, so the plugin's
`import { add } from "../native/src/lib.rs"` sugar, dev-time recompile-on-edit,
and build-time `emitFile` wiring are all inapplicable. **This is not a plugin
gap that can be fixed from the plugin side** — it is a framework-architecture
mismatch. If you want the full plugin experience with a Remix-lineage
framework, use React Router v7 (which absorbed Remix v2's model):
see [`examples/react-router`](../react-router).

What still transfers 1:1 is the *crate contract*: the same
`create-native-rust` scaffold, the same `#[napi]` exports, and the same
parallelism story (`async fn` on napi-rs's worker pool keeps the Node event
loop free). This example wires that crate into Remix 3 by hand.

## What this example does

- `native/` — napi-rs crate scaffolded with
  `node packages/create-native-rust/bin/create-native-rust.mjs examples/remix-v3/native --name remixdemo`
  (stock `add` / `sumTo` exports, untouched).
- `npm run build:native` — `napi build --release` produces
  `native/remixdemo.node` + regenerates `native/index.d.ts`. This replaces the
  plugin's on-demand compile: **you must run it before `dev`/`start`**, and
  re-run it after editing Rust (no recompile-on-edit here).
- `app/rust.server.ts` — loads the addon with a plain `createRequire()` of the
  `.node` file and re-exports typed `add`/`sumTo`. The `.server.ts` suffix is
  convention only: Remix 3 has no client module graph to protect — app code
  never reaches a browser bundle unless explicitly served as an asset.
- `app/actions/controller.tsx` — the `home` action calls `add(2, 3)` and
  `await sumTo(1000)` server-side and renders the results with `remix/ui` JSX
  (expected **5** and **500500**); `rustJson` serves the same as JSON at
  `/api/rust`.
- `server.ts` — the stock Remix 3 Node server for local dev/prod.

```sh
npm install                       # from the monorepo root
npm run build:native -w example-remix-v3
npm run dev -w example-remix-v3   # http://localhost:44100
curl -s localhost:44100/api/rust  # {"add":5,"sumTo":500500,"n":1000}
```

## Vercel deployment (project `vpnr-example-remix-v3`)

Remix 3 beta has **no Vercel adapter and no official deployment story** — the
docs cover Node/Bun/Deno/Cloudflare Workers servers. But `router.fetch` is a
plain fetch handler (`Request → Response`), which is exactly Vercel's
Web-standard function signature, so the whole app is served by one catch-all
function:

- `api/index.mjs` — exports `GET`/`POST`/… method handlers that delegate to
  `router.fetch(request)`. Method-named exports are required: a default export
  gets Vercel's legacy `(req, res)` Node signature and crashes (this was
  observed, not theorized).
- `vercel.json` — rewrites `/(.*)` → `/api/index` (the original request URL is
  preserved, so the Remix router matches the real paths), and
  `functions.includeFiles: "native/**"` ships the compiled addon into the
  function.
- `scripts/vercel-install.sh` / `vercel-build.sh` — same pattern as
  `examples/react-router`: install the npm workspace from the repo root,
  provision a minimal stable Rust toolchain into `node_modules/.cache` (the
  Vercel image ships rustup with no default toolchain), compile the crate
  on-target (linux x86_64), then pre-bundle the app (next bullet). Deployed
  with Root Directory = `examples/remix-v3` +
  "Include source files outside of the Root Directory".
- **The pre-bundle caveat:** Vercel's Node builder compiles the function entry
  per-file and does **not** compile the app's `.tsx` modules, and Remix 3's
  `remix/node-tsx` loader isn't available inside the packaged function (first
  attempt failed at runtime with `ERR_MODULE_NOT_FOUND` for
  `controller.js`). So `vercel-build.sh` runs `npm run build:vercel-bundle`
  (esbuild, `--jsx-import-source=remix/ui`, `remix` kept external for
  `@vercel/nft` to trace) producing `dist/app.mjs`, which `api/index.mjs`
  imports. Yes, that means the "no build step" framework gets a build step to
  fit serverless packaging — that is the honest cost of deploying Remix 3 beta
  on Vercel today.
- `public/robots.txt` exists because the "Other" framework preset refuses to
  deploy with a missing/empty output directory.

Deploy from the monorepo root: `vercel deploy --prod --yes`.

### Verified in production

```
$ curl -s https://vpnr-example-remix-v3.vercel.app/api/rust
{"add":5,"sumTo":500500,"n":1000}

$ curl -s https://vpnr-example-remix-v3.vercel.app/ | grep -o 'data-testid="[a-z-]*">[0-9]*'
data-testid="add">5
data-testid="sum-to">500500
```

## Caveats, honestly

- **Beta framework.** `remix@3.0.0-beta.5` is explicitly not production-ready;
  its APIs (router, `remix/ui`, middleware) may change and break this example.
- **No dev recompile-on-edit for Rust.** The plugin's hash-and-reload dev loop
  doesn't exist here; re-run `npm run build:native` after editing `lib.rs`
  (`node --watch` will then restart on the regenerated `index.d.ts`).
- **Types are hand-mirrored at the boundary.** `app/rust.server.ts` declares
  the addon's shape and validates the exports at load time; the generated
  `native/index.d.ts` is the source of truth to check it against.
- **The Vercel path is unofficial.** It leans on the Web-handler function
  signature, a catch-all rewrite, and an esbuild pre-bundle. It works (see
  above) but none of it is blessed by the Remix team, and the streamed-HTML
  render is buffered through Vercel's function response like any other
  fetch-handler body.
