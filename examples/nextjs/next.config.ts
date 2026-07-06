import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The napi loader + compiled `.node` binary are loaded at runtime with a
  // dynamic `createRequire` require (see lib/native.server.ts), which is
  // invisible to the bundler AND to @vercel/nft's static tracing. This config
  // is what actually carries the addon into the serverless function's file
  // set on Vercel. Paths are relative to the project root (examples/nextjs).
  //
  // Note: `serverExternalPackages: ["nextdemo"]` does NOT work here — the
  // package is a symlinked local `file:` dependency whose real path lives
  // outside node_modules, so Next bundles it anyway and the napi loader's
  // relative `require("./nextdemo.<platform>.node")` breaks in the chunk.
  outputFileTracingIncludes: {
    "/*": ["./native/index.js", "./native/*.node", "./native/package.json"],
  },
};

export default nextConfig;
