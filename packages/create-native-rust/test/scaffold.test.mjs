import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "../lib/scaffold.mjs";
import { lockfileNote, parseArgs, run } from "../lib/cli.mjs";
import { validateName, deriveNameFromDir } from "../lib/validate.mjs";

async function withTempDir(fn) {
  const base = await mkdtemp(join(tmpdir(), "create-native-rust-unit-"));
  try {
    return await fn(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function collectStream() {
  let data = "";
  return { write: (chunk) => { data += chunk; }, get text() { return data; } };
}

function hasCargo() {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Lockfile-step stubs: unit tests must stay fast and deterministic, so they
// never shell out to the real `cargo generate-lockfile` (network + seconds).
// `lockGenerated` mirrors the real success behavior (a Cargo.lock appears).
const lockGenerated = async (dir) => {
  await writeFile(join(dir, "Cargo.lock"), "# stub lockfile\n", "utf8");
  return { status: "generated" };
};
const lockSkipped = async () => ({ status: "skipped-no-cargo" });
const lockFailed = async () => ({ status: "failed", detail: "no network" });

test("scaffold writes the full file set (including the generated Cargo.lock)", async () => {
  await withTempDir(async (base) => {
    const target = join(base, "demo");
    const result = await scaffold({ dir: target, name: "demo", generateLockfile: lockGenerated });

    assert.equal(result.name, "demo");
    assert.deepEqual(result.files, [
      ".gitignore",
      "Cargo.lock",
      "Cargo.toml",
      "build.rs",
      "package.json",
      "src/lib.rs",
    ]);
    assert.equal(result.lockfile.status, "generated");
    assert.ok(await stat(join(target, "Cargo.lock")), "Cargo.lock exists on disk");
  });
});

test("generated package.json carries napi.binaryName matching the crate name", async () => {
  await withTempDir(async (base) => {
    const target = join(base, "widget");
    await scaffold({ dir: target, name: "widget", generateLockfile: lockSkipped });
    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    assert.equal(pkg.name, "widget");
    assert.equal(pkg.napi.binaryName, "widget");
  });
});

test("Cargo.toml declares a cdylib with napi v3 and a release profile", async () => {
  await withTempDir(async (base) => {
    const target = join(base, "demo");
    await scaffold({ dir: target, name: "demo", generateLockfile: lockSkipped });
    const cargo = await readFile(join(target, "Cargo.toml"), "utf8");
    assert.match(cargo, /crate-type = \["cdylib"\]/);
    assert.match(cargo, /napi = \{ version = "3"/);
    assert.match(cargo, /napi-derive = "3"/);
    assert.match(cargo, /napi-build = "2"/);
    assert.match(cargo, /lto = true/);
    assert.match(cargo, /strip = "symbols"/);
    assert.match(cargo, /^name = "demo"$/m);
  });
});

test("lib.rs contains one async and one sync doc-commented export", async () => {
  await withTempDir(async (base) => {
    const target = join(base, "demo");
    await scaffold({ dir: target, name: "demo", generateLockfile: lockSkipped });
    const lib = await readFile(join(target, "src/lib.rs"), "utf8");
    assert.match(lib, /pub async fn sum_to/);
    assert.match(lib, /pub fn add/);
    // both exports precede a doc comment (///) and the #[napi] macro
    assert.match(lib, /\/\/\/[^]*#\[napi\][^]*pub fn add/);
    assert.match(lib, /\/\/\/[^]*#\[napi\][^]*pub async fn sum_to/);
  });
});

test("build.rs invokes napi_build::setup", async () => {
  await withTempDir(async (base) => {
    const target = join(base, "demo");
    await scaffold({ dir: target, name: "demo", generateLockfile: lockSkipped });
    const buildRs = await readFile(join(target, "build.rs"), "utf8");
    assert.match(buildRs, /napi_build::setup\(\);/);
  });
});

test(".gitignore ignores target/ and *.node", async () => {
  await withTempDir(async (base) => {
    const target = join(base, "demo");
    await scaffold({ dir: target, name: "demo", generateLockfile: lockSkipped });
    const gi = await readFile(join(target, ".gitignore"), "utf8");
    assert.match(gi, /^target\/$/m);
    assert.match(gi, /^\*\.node$/m);
  });
});

test("name is derived from the directory when --name is omitted", async () => {
  await withTempDir(async (base) => {
    const target = join(base, "My_Cool.Crate");
    const result = await scaffold({ dir: target, generateLockfile: lockSkipped });
    assert.equal(result.name, "my-cool-crate");
    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    assert.equal(pkg.napi.binaryName, "my-cool-crate");
  });
});

test("refuses to scaffold into a non-empty directory", async () => {
  await withTempDir(async (base) => {
    const target = join(base, "occupied");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "hi", "utf8");
    await assert.rejects(
      scaffold({ dir: target, name: "occupied", generateLockfile: lockSkipped }),
      /exists and is not empty/,
    );
  });
});

test("rejects an invalid crate name", async () => {
  await withTempDir(async (base) => {
    const target = join(base, "demo");
    await assert.rejects(
      scaffold({ dir: target, name: "Bad Name!", generateLockfile: lockSkipped }),
      /invalid crate name/,
    );
  });
});

test("validateName accepts good names and rejects bad ones", () => {
  for (const good of ["native", "my-crate", "my_crate", "a1", "core-utils-2"]) {
    assert.equal(validateName(good), good);
  }
  for (const bad of ["", "1crate", "-crate", "crate-", "Crate", "a--b", "with space"]) {
    assert.throws(() => validateName(bad));
  }
});

test("deriveNameFromDir sanitizes or returns null", () => {
  assert.equal(deriveNameFromDir("/tmp/Some.Dir"), "some-dir");
  assert.equal(deriveNameFromDir("native"), "native");
  assert.equal(deriveNameFromDir("/tmp/123"), null);
});

test("parseArgs handles positional, --name, --name=, and help", () => {
  assert.deepEqual(parseArgs(["demo"]), { dir: "demo", name: undefined, help: false });
  assert.deepEqual(parseArgs(["demo", "--name", "foo"]), { dir: "demo", name: "foo", help: false });
  assert.deepEqual(parseArgs(["demo", "--name=foo"]), { dir: "demo", name: "foo", help: false });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["demo", "--bogus"]), /unknown option/);
  assert.throws(() => parseArgs(["a", "b"]), /extra argument/);
});

test("run prints usage and fails when no dir is given", async () => {
  const out = collectStream();
  const err = collectStream();
  const code = await run([], { out, err });
  assert.equal(code, 1);
  assert.match(err.text, /missing target directory/);
  assert.match(err.text, /Usage: create-native-rust/);
});

test("run prints help with exit 0", async () => {
  const out = collectStream();
  const err = collectStream();
  const code = await run(["--help"], { out, err });
  assert.equal(code, 0);
  assert.match(out.text, /Usage: create-native-rust/);
});

test("run scaffolds and prints the next-steps wiring", async () => {
  await withTempDir(async (base) => {
    const out = collectStream();
    const err = collectStream();
    const code = await run(["demo", "--name", "demo"], {
      cwd: base,
      out,
      err,
      generateLockfile: lockGenerated,
    });
    assert.equal(code, 0, err.text);
    assert.match(out.text, /import \{ rustPlugin \} from "vite-plugin-native-rust";/);
    assert.match(out.text, /"allowArbitraryExtensions": true/);
    assert.match(out.text, /import \{ add, sumTo \} from "\.\/demo\/src\/lib\.rs";/);
    assert.match(out.text, /~30s cold/);
    assert.match(out.text, /Commit the crate's Cargo\.lock/);
    assert.doesNotMatch(out.text, /note: /, "no lockfile note when generation succeeded");
  });
});

test("run prints a note (but still succeeds) when cargo is unavailable for the lockfile", async () => {
  await withTempDir(async (base) => {
    const out = collectStream();
    const err = collectStream();
    const code = await run(["demo", "--name", "demo"], {
      cwd: base,
      out,
      err,
      generateLockfile: lockSkipped,
    });
    assert.equal(code, 0, err.text);
    assert.match(out.text, /note: cargo not found — skipped generating Cargo\.lock/);
    assert.match(out.text, /cargo generate-lockfile/);
    assert.match(out.text, /compile the crate twice/);
  });
});

test("run prints a failure note (but still succeeds) when generate-lockfile fails", async () => {
  await withTempDir(async (base) => {
    const out = collectStream();
    const err = collectStream();
    const code = await run(["demo", "--name", "demo"], {
      cwd: base,
      out,
      err,
      generateLockfile: lockFailed,
    });
    assert.equal(code, 0, err.text);
    assert.match(out.text, /note: `cargo generate-lockfile` failed \(no network\)/);
    assert.match(out.text, /scaffold is still complete/);
  });
});

test("scaffold reports the lockfile status without ever throwing over it", async () => {
  await withTempDir(async (base) => {
    const skipped = await scaffold({
      dir: join(base, "a"),
      name: "a1",
      generateLockfile: lockSkipped,
    });
    assert.equal(skipped.lockfile.status, "skipped-no-cargo");
    assert.ok(!skipped.files.includes("Cargo.lock"), "no Cargo.lock claimed when skipped");

    const failed = await scaffold({
      dir: join(base, "b"),
      name: "b1",
      generateLockfile: lockFailed,
    });
    assert.equal(failed.lockfile.status, "failed");
    assert.equal(failed.lockfile.detail, "no network");
    assert.ok(!failed.files.includes("Cargo.lock"), "no Cargo.lock claimed when failed");
  });
});

test("lockfileNote is silent on success and speaks on skip/failure", () => {
  assert.equal(lockfileNote({ status: "generated" }, "demo"), null);
  assert.equal(lockfileNote(undefined, "demo"), null);
  assert.match(lockfileNote({ status: "skipped-no-cargo" }, "demo"), /cargo not found/);
  assert.match(
    lockfileNote({ status: "failed", detail: "boom" }, "demo"),
    /failed \(boom\)/,
  );
});

test(
  "real cargo: default scaffold ships a real Cargo.lock from birth",
  { skip: hasCargo() ? false : "cargo not installed — skipping real lockfile generation", timeout: 180_000 },
  async () => {
    await withTempDir(async (base) => {
      const target = join(base, "demo");
      const result = await scaffold({ dir: target, name: "demo" });
      assert.equal(result.lockfile.status, "generated", JSON.stringify(result.lockfile));
      assert.ok(result.files.includes("Cargo.lock"));
      const lock = await readFile(join(target, "Cargo.lock"), "utf8");
      assert.match(lock, /name = "demo"/, "lockfile resolves the scaffolded crate itself");
      assert.match(lock, /name = "napi"/, "lockfile resolves the napi dependency tree");
    });
  },
);
