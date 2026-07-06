// "stub" project: the same .rs import is redirected to a JS twin by
// rustTestStub, so no cargo runs. sumTo returns the twin's sentinel (0), not
// the real 5050 — proving the redirect took effect.
import { expect, test } from "vitest";

import { add, summary, sumTo } from "../app/rust-demo.server.ts";

test("add() comes from the JS twin (same arithmetic)", () => {
  expect(add(40, 2)).toBe(42);
});

test("sumTo() returns the twin sentinel, not the native value", async () => {
  expect(await sumTo(100)).toBe(0);
});

test("summary() composes the stubbed results", async () => {
  expect(await summary()).toBe("add=42;sumTo=0");
});
