// Vercel Node function wrapping the built Qwik City server.
//
// Qwik City's official Vercel adapter deploys edge-only, and edge functions
// cannot load native addons — so this example uses Vercel's zero-config
// functions directory with the Node runtime instead. The catch-all rewrite in
// vercel.json sends every non-static request here.
//
// This file is compiled by Vercel's Node builder AFTER the buildCommand has
// produced server/entry.vercel-node.js. @vercel/nft traces that import —
// including the `new URL("qwikdemo-<hash>.node", import.meta.url)` reference
// the plugin generates — and packages the addon into the function at the same
// relative path.
export { default } from "../server/entry.vercel-node.js";
