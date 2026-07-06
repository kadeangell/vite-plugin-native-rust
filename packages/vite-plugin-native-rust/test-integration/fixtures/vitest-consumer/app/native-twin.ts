// JS stand-in for ../native/src/lib.rs, wired up by rustTestStub in the "stub"
// vitest project. `add` mirrors the real crate; `sumTo` returns a deliberate
// sentinel (0) so a test can prove the stub — not the compiled Rust — answered.
export function add(a: number, b: number): number {
  return a + b;
}

export async function sumTo(_n: number): Promise<number> {
  return 0;
}
