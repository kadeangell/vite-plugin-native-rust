# create-native-rust

Scaffold a [napi-rs](https://napi.rs) crate that's ready to import directly from
your Vite SSR server code with
[`vite-plugin-native-rust`](https://github.com/kadeangell/vite-plugin-native-rust).

> **Experimental — 0.1.** See the
> [plugin repo](https://github.com/kadeangell/vite-plugin-native-rust) for the
> supported matrix.

## Usage

```bash
npm create native-rust native
# or with an explicit binary name
npm create native-rust native -- --name native
```

This generates, in `./native/`:

- `Cargo.toml` — a `cdylib` crate with napi v3 + napi-derive v3 and an
  `lto` + `strip` release profile.
- `build.rs` — `napi_build::setup()`.
- `src/lib.rs` — a sync `add` and an async `sumTo` sample export, both
  doc-commented so the generated types carry the docs into your editor.
- `package.json` — carries the `napi.binaryName` that napi v3 requires.
- `.gitignore` — ignores `target/` and `*.node`.
- `Cargo.lock` — generated at scaffold time via `cargo generate-lockfile`
  (when cargo is on your PATH; skipped with a printed note otherwise).
  **Commit it**: the lockfile is part of the plugin's compile-cache key, so a
  crate born without one changes key after its first compile and costs cold
  multi-step builds (e.g. Nuxt's Vite + Nitro pipelines) an extra identical
  ~30s compile.

After scaffolding, the CLI prints the exact vite.config, tsconfig, and import
wiring to finish hooking the crate into your app — the same steps as the
[plugin quickstart](https://github.com/kadeangell/vite-plugin-native-rust#quickstart).

## Options

| Flag | Description |
| --- | --- |
| `--name <binaryName>` | Crate/binary name. Defaults to a sanitized form of `<dir>`. |
| `-h`, `--help` | Show help. |

The CLI refuses to overwrite a non-empty directory and validates that the name
is a usable crate/npm identifier (lowercase, starts with a letter, `-`/`_`
separators).

## License

MIT
