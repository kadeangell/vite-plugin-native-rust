// Vercel function entry. Remix 3 has no Vercel adapter (beta), but its router
// is a plain fetch handler (Request → Response), which is exactly Vercel's
// Node.js "web handler" function signature — so the whole app is served by
// this one catch-all function (see the rewrite in ../vercel.json).
//
// Why this imports a pre-bundled ../dist/app.mjs instead of ../app/router.ts:
// Remix 3 runs from TS/JSX source via its `remix/node-tsx` Node loader, which
// is not available inside Vercel's function packaging — and Vercel's Node
// builder does not compile the app's .tsx modules. scripts/vercel-build.sh
// therefore pre-bundles app/router.ts with esbuild (jsxImportSource remix/ui)
// into dist/app.mjs before this file is traced. The native addon is compiled
// on the build machine in the same script and shipped via vercel.json's
// includeFiles.
import { router } from '../dist/app.mjs'

// HTTP-method named exports opt this function into Vercel's Web-standard
// handler signature (Request → Response); a default export would instead be
// invoked with the legacy Node (req, res) pair, which the Remix router does
// not speak.
async function handler(request) {
  try {
    return await router.fetch(request)
  } catch (error) {
    if (!(request.signal?.aborted && error === request.signal.reason)) {
      console.error(error)
    }
    return new Response('Internal Server Error', { status: 500 })
  }
}

export const GET = handler
export const HEAD = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const OPTIONS = handler
