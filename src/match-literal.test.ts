import { describe, it, expect } from "bun:test";
import { evaluate, EMPTY_ENV } from "./evaluate.ts";
import type { Value } from "./value.ts";
import type { Expr } from "./types.ts";

// --- Helpers ---

function ok(value: Value): { ok: true; value: Value } {
  return { ok: true, value };
}

function err(code: string) {
  return expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) });
}

function int(n: number | bigint): Value {
  return { kind: "int", value: typeof n === "bigint" ? n : BigInt(n) };
}

function float(n: number): Value {
  return { kind: "float", value: n };
}

function str(s: string): Value {
  return { kind: "string", value: s };
}

function bool(b: boolean): Value {
  return { kind: "bool", value: b };
}

function variant(tag: string, ...fields: Value[]): Value {
  return { kind: "variant", tag, fields };
}

const NULL: Value = { kind: "null" };

// --- Literal match tests ---

describe("match on literal values", () => {
  it("matches string value using string tag", () => {
    // scrutinee: "hello", pattern tag: "hello" -> matches
    const expr: Expr = ["match", "x", [["hello"], 1], [["world"], 2]];
    const env = EMPTY_ENV.extend({ x: str("hello") });
    expect(evaluate(expr, env)).toEqual(ok(int(1)));
  });

  it("matches second string clause", () => {
    const expr: Expr = ["match", "x", [["hello"], 1], [["world"], 2]];
    const env = EMPTY_ENV.extend({ x: str("world") });
    expect(evaluate(expr, env)).toEqual(ok(int(2)));
  });

  it("binds scrutinee value in string match", () => {
    const expr: Expr = ["match", "x", [["hello", "v"], "v"]];
    const env = EMPTY_ENV.extend({ x: str("hello") });
    expect(evaluate(expr, env)).toEqual(ok(str("hello")));
  });

  it("matches null via string tag 'null'", () => {
    const expr: Expr = ["match", "x", [["null"], 42], [["true"], 1]];
    const env = EMPTY_ENV.extend({ x: NULL });
    expect(evaluate(expr, env)).toEqual(ok(int(42)));
  });

  it("matches null via null tag", () => {
    const expr: Expr = ["match", "x", [[null], 42]];
    const env = EMPTY_ENV.extend({ x: NULL });
    expect(evaluate(expr, env)).toEqual(ok(int(42)));
  });

  it("matches bool true via string tag 'true'", () => {
    const expr: Expr = ["match", "x", [["true"], 1], [["false"], 0]];
    const env = EMPTY_ENV.extend({ x: bool(true) });
    expect(evaluate(expr, env)).toEqual(ok(int(1)));
  });

  it("matches bool false via string tag 'false'", () => {
    const expr: Expr = ["match", "x", [["true"], 1], [["false"], 0]];
    const env = EMPTY_ENV.extend({ x: bool(false) });
    expect(evaluate(expr, env)).toEqual(ok(int(0)));
  });

  it("matches bool true via boolean tag", () => {
    const expr: Expr = ["match", "x", [[true], 1], [[false], 0]];
    const env = EMPTY_ENV.extend({ x: bool(true) });
    expect(evaluate(expr, env)).toEqual(ok(int(1)));
  });

  it("matches bool false via boolean tag", () => {
    const expr: Expr = ["match", "x", [[true], 1], [[false], 0]];
    const env = EMPTY_ENV.extend({ x: bool(false) });
    expect(evaluate(expr, env)).toEqual(ok(int(0)));
  });

  it("matches int value via number tag", () => {
    const expr: Expr = ["match", "x", [[1], 10], [[2], 20], [[3], 30]];
    const env = EMPTY_ENV.extend({ x: int(2) });
    expect(evaluate(expr, env)).toEqual(ok(int(20)));
  });

  it("matches int value 0 via number tag", () => {
    const expr: Expr = ["match", "x", [[0], 100], [[1], 200]];
    const env = EMPTY_ENV.extend({ x: int(0) });
    expect(evaluate(expr, env)).toEqual(ok(int(100)));
  });

  it("matches float value via number tag", () => {
    const expr: Expr = ["match", "x", [[1.5], 15], [[2.5], 25]];
    const env = EMPTY_ENV.extend({ x: float(1.5) });
    expect(evaluate(expr, env)).toEqual(ok(int(15)));
  });

  it("binds scrutinee value in int match", () => {
    const expr: Expr = ["match", "x", [[42, "v"], "v"]];
    const env = EMPTY_ENV.extend({ x: int(42) });
    expect(evaluate(expr, env)).toEqual(ok(int(42)));
  });

  it("returns NON_EXHAUSTIVE_MATCH when no clause matches", () => {
    const expr: Expr = ["match", "x", [["hello"], 1]];
    const env = EMPTY_ENV.extend({ x: str("goodbye") });
    expect(evaluate(expr, env)).toEqual(err("NON_EXHAUSTIVE_MATCH"));
  });

  it("returns NON_EXHAUSTIVE_MATCH for unmatched int", () => {
    const expr: Expr = ["match", "x", [[1], 1], [[2], 2]];
    const env = EMPTY_ENV.extend({ x: int(99) });
    expect(evaluate(expr, env)).toEqual(err("NON_EXHAUSTIVE_MATCH"));
  });

  it("returns ARITY_ERROR when literal pattern has more than one binding", () => {
    const expr: Expr = ["match", "x", [["hello", "a", "b"], 1]];
    const env = EMPTY_ENV.extend({ x: str("hello") });
    expect(evaluate(expr, env)).toEqual(err("ARITY_ERROR"));
  });
});

describe("match on variants still works (regression)", () => {
  it("matches variant tag", () => {
    const expr: Expr = ["match", "x", [["Some", "v"], "v"], [["None"], 0]];
    const env = EMPTY_ENV.extend({ x: variant("Some", int(7)) });
    expect(evaluate(expr, env)).toEqual(ok(int(7)));
  });

  it("matches None variant with no fields", () => {
    const expr: Expr = ["match", "x", [["Some", "v"], "v"], [["None"], 0]];
    const env = EMPTY_ENV.extend({ x: variant("None") });
    expect(evaluate(expr, env)).toEqual(ok(int(0)));
  });

  it("non-exhaustive variant still errors", () => {
    const expr: Expr = ["match", "x", [["Some", "v"], "v"]];
    const env = EMPTY_ENV.extend({ x: variant("None") });
    expect(evaluate(expr, env)).toEqual(err("NON_EXHAUSTIVE_MATCH"));
  });
});
