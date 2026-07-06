# Showcase crates — one crate per demo

Each demo in this app imports its own **independent** napi-rs crate from here.
There is deliberately no shared workspace crate with feature-gated modules:
that would tangle the content-hash cache (a change to one demo's Rust would
invalidate every demo's cached addon and force a full recompile). Separate
crates keep each demo's compile isolated — tantivy and ravif have multi-minute
cold builds, and you don't want those on the critical path of an argon2 tweak.

Every crate here is also a distinct `.rs` import site, so this directory doubles
as living proof that the plugin supports **multiple native crates in one app**.

## Layout

```
crates/
  health/     smoke crate — add / sumTo, imported by /health (this file's proof)
  search/     tantivy full-text search        (/search)   — scaffolded by its demo agent
  images/     image + ravif thumbnail pipeline (/images)   — scaffolded by its demo agent
  transform/  lol_html + ammonia HTML rewrite (/transform) — scaffolded by its demo agent
  hashing/    argon2 password hashing         (/hashing)   — scaffolded by its demo agent
```

Only `health/` exists today; the four demo crates are scaffolded by their
respective demo agents.

## Adding a demo crate

```bash
# from the repo root
node packages/create-native-rust/bin/create-native-rust.mjs \
  examples/showcase/crates/<demo> --name <demo>

# generate the lockfile up front so the first build doesn't compile twice
cd examples/showcase/crates/<demo> && cargo generate-lockfile
```

Then import it from a server-only module in `app/` with a single line:

```ts
// app/<demo>.server.ts
import { someExport } from "../crates/<demo>/src/lib.rs";
```

The plugin compiles the enclosing crate to a native addon, content-hash caches
it, and mirrors napi's generated types next to the `.rs` file as
`lib.d.rs.ts` (committed so CI typechecks without a Rust toolchain).

## What to commit per crate

`Cargo.toml`, `Cargo.lock`, `build.rs`, `package.json`, `src/lib.rs`, and the
generated `src/lib.d.rs.ts`. Build output (`target/`, `*.node`) is git-ignored.
