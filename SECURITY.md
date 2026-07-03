# Security Policy

## Supported versions

This is an experimental 0.1 project. Security fixes are made against the latest
published `0.1.x` release.

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues.**

Report privately through GitHub's security advisories:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** (or use
   <https://github.com/kadeangell/vite-plugin-native-rust/security/advisories/new>).
3. Describe the issue, how to reproduce it, and its impact.

You'll get an acknowledgement, and we'll work with you on a fix and coordinated
disclosure before any public discussion.

## Scope notes

This plugin runs a build-time toolchain (`cargo` / `@napi-rs/cli`) and compiles
Rust crates from your project into native addons that load at runtime. The most
relevant risk surface is therefore the **build**: the plugin executes `cargo`,
`rustc`, and `napi build` on the crate sources it's pointed at. Only import `.rs`
files from crates you trust, exactly as you would only run `npm install` on
dependencies you trust. Reports about the plugin's own handling of paths, cache
files, or generated code are in scope.
