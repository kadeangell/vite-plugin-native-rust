// "native" project: the .rs import flows through rustPlugin() in the vitest
// config, so this asserts the REAL Rust output. The project runs in a jsdom
// environment on purpose — that makes vitest transform the module graph with
// ssr=false, which is exactly the case the plugin's client-graph gate would
// otherwise reject. Green here proves the gate bypass and the dev-shape loader.
import { expect, test } from "vitest";

import { add, summary, sumTo } from "../app/rust-demo.server.ts";

test("add() returns the real Rust sum", () => {
  expect(add(40, 2)).toBe(42);
});

test("sumTo() returns the real Rust triangular number", async () => {
  expect(await sumTo(100)).toBe(5050);
});

test("summary() composes the real native results", async () => {
  expect(await summary()).toBe("add=42;sumTo=5050");
});
