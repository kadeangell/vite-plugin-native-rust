# Contributing

Thanks for helping improve `vite-plugin-native-rust`. It's an experimental 0.1
project, so contributions of all sizes are welcome — bug reports, fixture apps,
docs fixes, and code.

## Prerequisites

- **Node.js >= 20**
- **A Rust toolchain** — `cargo` on your `PATH`. Install from <https://rustup.rs>.
  The tests and example compile real crates, so this is required, not optional.
- **macOS or Linux.** Windows support is not planned; a well-tested community
  PR would be considered, but it is not on the roadmap.

## Repository layout

This is an npm workspaces monorepo:

```
packages/
  vite-plugin-native-rust/   the Vite plugin (src/ → dist/ via tsup), unit + integration tests
  create-native-rust/        the `npm create native-rust` scaffolding CLI
examples/
  react-router/              a runnable React Router v7 app with the Rust A/B routes + Vercel wiring
docs/                        the user-facing documentation
```

The history docs at the repo root (`PLAN.md`, `SPIKE-FINDINGS.md`,
`MEASUREMENTS*.md`, `VERCEL-*.md`) record how and why the plugin was built and
what was measured — read them if you're touching the compile/cache/emit pipeline.

## Setup

```bash
git clone https://github.com/kadeangell/vite-plugin-native-rust.git
cd vite-plugin-native-rust
npm install
```

`npm install` bootstraps every workspace. The example app depends on the plugin
**by name** and exercises its built `dist/` — the same code that ships — so build
the plugin before running the example:

```bash
npm run build:plugin        # tsup: ESM + .d.ts into packages/vite-plugin-native-rust/dist
```

## Common commands

Run from the repo root:

| Command | What it does |
| --- | --- |
| `npm run build:plugin` | Build the plugin package to `dist/`. |
| `npm run build` | Build the plugin, then the example app. |
| `npm test` | Run the plugin's test suite. |
| `npm test -w vite-plugin-native-rust` | Plugin unit + integration tests (`node --test`). |
| `npm test -w create-native-rust` | CLI tests, including an end-to-end scaffold-and-`napi build`. |
| `npm run typecheck` | Type-check every workspace that has a `typecheck` script. |

To run the example app against the built plugin:

```bash
npm run build:plugin
npm run dev -w example-react-router      # then hit /rust and /slow-cpu-rust
```

## Tests

- **Unit tests** live beside the source (`src/*.test.ts` in the plugin), run with
  Node's built-in test runner (`node --test`). They cover options validation, the
  dependency-closure hashing, toolchain-key invalidation, codegen, and in-flight
  dedupe.
- **Integration tests** exercise the real compile → cache → emit → run path
  against fixture apps (vanilla Vite SSR and React Router). They compile actual
  crates, so they need the Rust toolchain.
- **CLI tests** scaffold a crate into a temp dir and `napi build` it to assert the
  exports are real.

If you add behavior, add a test for it. Prefer many small, focused test files over
large ones.

## Coding conventions

- **Immutability.** Return new objects; don't mutate inputs (the codebase follows
  this throughout — e.g. options resolution and package.json augmentation).
- **Small, focused files.** High cohesion, low coupling; extract utilities rather
  than growing a module.
- **Explicit types on public APIs.** Avoid `any`; narrow `unknown` at boundaries.
- **Actionable errors.** Every failure the user can hit should say what went wrong
  and what to do about it — match the existing error messages (they name the file,
  the crate, and the fix).

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Pull requests

1. Branch from `main`.
2. Keep the change focused; describe **what** and **why**, not just what.
3. Make sure `npm test` and `npm run typecheck` pass locally, and CI is green —
   green CI is the bar, not "should pass". The CI matrix runs on Ubuntu and macOS
   across Node 20/22/24 and Vite 6/7.
4. Add or update tests and docs for any behavior change. If you touch an option or
   the pipeline, update the relevant file under `docs/`.
5. If you changed Rust signatures in a fixture or the example, commit the
   regenerated `.d.rs.ts` alongside.

## Reporting bugs and requesting features

Use the issue templates — the bug template asks for your OS, Node, Vite, `rustc`,
and `@napi-rs/cli` versions plus the plugin's log output, which is what we need to
reproduce. For security issues, do **not** open a public issue — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT
License.
