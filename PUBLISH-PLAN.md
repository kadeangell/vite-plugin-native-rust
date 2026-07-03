# Publish plan: `vite-plugin-native-rust` v0.1.0

## Goal

Turn the working scratchpad into a legitimate, publishable npm package:
`npm i -D vite-plugin-native-rust` + a scaffolding CLI, with CI-verified
support for React Router v7/v8 and vanilla Vite SSR on macOS/Linux, docs that
earn trust, and a public GitHub repo. Everything publish-ready; the final
`npm publish` is gated on the user (npm CLI is not authenticated — user runs
`npm login` and confirms).

## Locked decisions (user, 2026-07-02)

- **Name:** `vite-plugin-native-rust` (available; `vite-plugin-rust` is a
  taken WASM-adjacent name; "native" is the differentiator).
- **Repo:** public, `github.com/kadeangell/vite-plugin-native-rust`.
- **Scope:** full Tier 1–3 — extraction, config surface, correctness
  hardening, scaffolding CLI, integration tests + CI matrix, framework matrix
  (RR v7, RR v8, vanilla Vite SSR), site-grade docs. **Windows excluded**
  (documented as unsupported-yet).
- **Positioning:** native Rust (napi-rs) for Vite *server* code — latency and
  serverless-CPU-cost wins, with the local + Vercel measurement receipts.
- **Docs form:** well-organized markdown in-repo (`README` + `docs/`). No
  docs-site generator at 0.1 — revisit if adoption warrants.
- **Version:** 0.1.0, published with `--provenance` once CI is green.
  Experimental label in README until 0.2.

## Repo layout (after P0)

```
vite-plugin-native-rust/            (repo root = npm workspaces root)
  packages/
    vite-plugin-native-rust/        src/ → dist/ (tsup: ESM + .d.ts), unit+integration tests
    create-native-rust/             scaffolding CLI (npm create native-rust)
  examples/
    react-router/                   the existing RRv7 app (app/, native/, vercel wiring)
  docs/                             quickstart, how-it-works, typescript, vercel, benchmarks,
                                    troubleshooting, when-not-to-use
  .github/workflows/                ci.yml (matrix), release.yml
  PLAN.md, VERCEL-*.md, MEASUREMENTS*.md, SPIKE-FINDINGS.md, PUBLISH-PLAN.md
                                    (history docs, kept at root)
```

## Waves

### Wave P0 — foundation: git, monorepo, extraction, GitHub (sequential, one agent)

1. `git init`, commit the current working state verbatim (pre-restructure
   baseline — the safety net for everything after). Secrets scan before any
   commit (nothing sensitive is expected; verify).
2. Restructure to npm workspaces per the layout above. The plugin package
   builds with tsup (ESM + `.d.ts`, no `.ts`-extension imports in dist),
   `files` whitelist, `exports` map, `peerDependencies`: `vite >=6`,
   `@napi-rs/cli >=3` (peer — the user installs it), `engines.node >=20`.
   MIT LICENSE.
3. Example app depends on the workspace package by name; its dev/build flows
   must exercise the **built dist** (what ships), not the TS source.
4. Everything green post-move: plugin unit tests (moved into the package),
   example `npm run dev` serving `/rust` digest, `npm run build`, typecheck.
5. Vercel: keep the deployed project working — set the project's
   `rootDirectory` to the example (via `vercel` CLI/API), or document
   precisely what manual dashboard change is needed if the API path fails.
   Best-effort redeploy verification; honest report either way.
6. `gh repo create kadeangell/vite-plugin-native-rust --public`, push main.

### Wave P1 — hardening + CLI (two agents, parallel, disjoint packages)

**Agent A — plugin hardening (packages/vite-plugin-native-rust):**
- **Workspace/path-dep hashing (the silent-corruption fix):** derive the
  crate's full local dependency closure via `cargo metadata` — path deps,
  workspace members, workspace-level `Cargo.toml`/`Cargo.lock` — and fold all
  of it into the cache hash AND `addWatchFile` set. A change in a sibling
  path-dep crate must recompile.
- **Toolchain in the cache key:** `rustc -V` + napi CLI version, so toolchain
  upgrades invalidate.
- **Cross-process safety:** write cache artifacts to temp + atomic rename;
  two concurrent Vite processes must not corrupt or double-compile
  destructively.
- **Options surface** (validated, defaults = today's behavior):
  `cacheDir`, `profile` ('debug'|'release'|auto), `napiArgs`,
  `generateCratePackageJson` (bool), `emitTypes` (bool), `logLevel`.
- Unit tests for every item above.

**Agent B — scaffolding CLI (packages/create-native-rust):**
- `npm create native-rust <dir>` generates a ready crate: `Cargo.toml`
  (cdylib, napi v3 deps), `build.rs`, `src/lib.rs` with one async + one sync
  sample export, the napi `package.json` (binaryName gotcha), `.gitignore`
  entries — then prints the vite/tsconfig wiring steps.
- Check the `create-native-rust` npm name is free; pick fallback and update
  this plan if not.
- Test: run the CLI into a temp dir, `napi build` the result, assert exports.

### Wave P2 — proof + docs (two agents, parallel)

**Agent C — integration tests + CI + framework matrix:**
- Integration fixtures in the plugin package: (1) vanilla Vite SSR app,
  (2) RR v7 (reuse example), (3) RR v8 (new minimal fixture). For each:
  dev-server request → digest assert; `vite build` → run output → assert;
  cache-hit (second build compiles nothing); client-leak import → friendly
  error assert; options behavior spot checks.
- `.github/workflows/ci.yml`: (ubuntu, macos) × Node (20, 22, 24) × Vite
  (6, 7) with Rust + cargo + plugin-cache caching; lint/typecheck job.
  `release.yml`: tag-triggered `npm publish --provenance` (manual dispatch
  guard).
- Push; iterate until CI is green on GitHub — CI green is the acceptance
  criterion, not "should pass".

**Agent D — docs (README + docs/):**
- README: what/why in three sentences, the measurement headline with links,
  quickstart (install → create crate via CLI → import → dev), experimental
  label, supported matrix, license.
- `docs/`: how-it-works (the resolve/load/compile/cache/emitFile story),
  typescript.md (`allowArbitraryExtensions`, `.d.rs.ts`), deployment-vercel.md
  (adapted from VERCEL-DEPLOY.md), benchmarks.md (from both MEASUREMENTS
  docs, including the honest serverless fan-out correction),
  troubleshooting.md (napi package.json, toolchain, first-compile wait, cache),
  when-not-to-use.md (I/O-bound, WASM-sufficient, Windows, edge runtimes).
- CONTRIBUTING.md, issue templates, minimal code of conduct.

### Wave P3 — release readiness (lead reviews, one agent assists)

- `npm pack` dry-run + `publint` + `arethetypeswrong` on the tarball; fix
  what they flag. Version 0.1.0, CHANGELOG.md.
- Full local + CI health pass; example app still deploys/serves.
- **GATE:** hand to user for `npm login` + publish confirmation (publish is
  irreversible and npm auth is theirs). Everything else done.

## Sharp edges

1. **npm auth** — publish blocked until the user logs in; plan ends at a
   verified-ready tarball + gate.
2. **Vercel root move** — restructure changes the deploy root; the linked
   project must be re-pointed or the deploy re-verified. Do not break the
   live URL silently.
3. **Workspace example must consume dist** — the classic monorepo trap of
   testing TS source that differs from the shipped build.
4. **`cargo metadata` cost** — runs per load; cache it per crate-dir with
   mtime guard so dev-server latency doesn't regress.
5. **RR v8 fixture** — v8 is latest-on-npm and its Vite integration may
   differ; if the `options.ssr` contract changed, that's a finding to fix in
   the plugin, not to paper over in the fixture.
6. **History docs contain the live Vercel URL and account slug** — fine for a
   public repo (already public infrastructure), but no tokens/secrets may
   land in git; scan before first push.

## Out of scope (0.1)

- Windows (documented as not-yet; issue opened at launch).
- Docs site generator, logo/branding.
- Non-Vite bundlers (unplugin port), Deno/Bun runtimes.
- Cross-compilation & prebuilt binary distribution for consumers' deploys
  (Vercel-style build-on-target is the documented path).
