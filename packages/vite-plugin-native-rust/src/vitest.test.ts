import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isVitest,
  resolveRelease,
  shouldBypassSsrGate,
  shouldUseDevShape,
} from "./vitest.ts";

test("isVitest: true when VITEST env is exactly 'true'", () => {
  assert.equal(isVitest(undefined, { VITEST: "true" }), true);
});

test("isVitest: a truthy-but-not-'true' VITEST alone does not trigger env branch", () => {
  // Only the env signal is checked here; falls through to the config check.
  assert.equal(isVitest(undefined, { VITEST: "1" }), false);
  assert.equal(isVitest({}, { VITEST: "1" }), false);
});

test("isVitest: true when the resolved config carries a `test` key", () => {
  assert.equal(isVitest({ test: {} }, {}), true);
  assert.equal(isVitest({ test: undefined }, {}), true); // key present is enough
});

test("isVitest: false for a plain build config with no markers", () => {
  assert.equal(isVitest({ root: "/app", plugins: [] }, {}), false);
  assert.equal(isVitest(undefined, {}), false);
  assert.equal(isVitest(null, {}), false);
});

test("shouldBypassSsrGate: vitest bypasses regardless of ssr", () => {
  assert.equal(shouldBypassSsrGate(true, undefined), true);
  assert.equal(shouldBypassSsrGate(true, false), true);
});

test("shouldBypassSsrGate: outside vitest only ssr===true passes", () => {
  assert.equal(shouldBypassSsrGate(false, true), true);
  assert.equal(shouldBypassSsrGate(false, false), false);
  assert.equal(shouldBypassSsrGate(false, undefined), false);
});

test("shouldUseDevShape: dev shape under vitest even when not watching", () => {
  assert.equal(shouldUseDevShape(true, false), true);
  assert.equal(shouldUseDevShape(true, true), true);
});

test("shouldUseDevShape: outside vitest tracks watchMode", () => {
  assert.equal(shouldUseDevShape(false, true), true);
  assert.equal(shouldUseDevShape(false, false), false);
});

test("resolveRelease: explicit profile always wins", () => {
  assert.equal(resolveRelease("release", true, true), true);
  assert.equal(resolveRelease("debug", false, false), false);
});

test("resolveRelease: default is debug under vitest, debug in watch, release in build", () => {
  assert.equal(resolveRelease(null, false, true), false); // vitest → debug
  assert.equal(resolveRelease(null, true, false), false); // watch → debug
  assert.equal(resolveRelease(null, false, false), true); // build → release
});
