import { describe, it, expect } from "bun:test";
import { freeVariables } from "./free-vars.ts";
import type { Expr } from "./types.ts";

describe("freeVariables", () => {
  it("null literal — no free vars", () => {
    expect(freeVariables(null)).toEqual(new Set());
  });

  it("boolean literal — no free vars", () => {
    expect(freeVariables(true)).toEqual(new Set());
    expect(freeVariables(false)).toEqual(new Set());
  });

  it("number literal — no free vars", () => {
    expect(freeVariables(42)).toEqual(new Set());
    expect(freeVariables(3.14)).toEqual(new Set());
  });

  it("string atom — one free var", () => {
    expect(freeVariables("x")).toEqual(new Set(["x"]));
  });

  it("application with free vars", () => {
    expect(freeVariables(["+", "a", "b"])).toEqual(new Set(["a", "b"]));
  });

  it("fn binding — params not free in body", () => {
    // ["fn", ["x", "y"], ["+", "x", "z"]]
    // x and y are bound; z is free
    const expr: Expr = ["fn", ["x", "y"], ["+", "x", "z"]];
    expect(freeVariables(expr)).toEqual(new Set(["z"]));
  });

  it("fn binding — no free vars when body only uses params", () => {
    const expr: Expr = ["fn", ["x"], ["+", "x", 1]];
    expect(freeVariables(expr)).toEqual(new Set());
  });

  it("let binding — name not free in body", () => {
    // ["let", [["x", "a"]], ["+", "x", "b"]]
    // a is free (binding expr in outer scope), x is bound, b is free
    const expr: Expr = ["let", [["x", "a"]], ["+", "x", "b"]];
    expect(freeVariables(expr)).toEqual(new Set(["a", "b"]));
  });

  it("let binding — binding exprs evaluated in outer scope", () => {
    // x is bound in body but NOT in binding expr for y
    const expr: Expr = [
      "let",
      [
        ["x", "outer"],
        ["y", "x"],
      ],
      ["+", "x", "y"],
    ];
    // "outer" is free, "x" in ["y", "x"] is free (not yet bound), x and y in body are bound
    expect(freeVariables(expr)).toEqual(new Set(["outer", "x"]));
  });

  it("letrec — names bound in both binding exprs and body", () => {
    // ["letrec", [["f", ["fn", ["x"], ["call", "f", "x"]]], ["g", "f"]], ["call", "f", "g"]]
    // f and g are bound everywhere; x is bound inside fn
    const expr: Expr = [
      "letrec",
      [
        ["f", ["fn", ["x"], ["call", "f", "x"]]],
        ["g", "f"],
      ],
      ["call", "f", "g"],
    ];
    expect(freeVariables(expr)).toEqual(new Set());
  });

  it("letrec — free vars from binding exprs that are not letrec-bound", () => {
    const expr: Expr = ["letrec", [["x", "outer"]], "x"];
    expect(freeVariables(expr)).toEqual(new Set(["outer"]));
  });

  it("match — field bindings not free in clause body", () => {
    // ["match", "val", [["Some", "v"], ["+", "v", 1]], [["None"], 0]]
    const expr: Expr = [
      "match",
      "val",
      [
        ["Some", "v"],
        ["+", "v", "extra"],
      ],
      [["None"], 0],
    ];
    // val is free (scrutinee), v is bound in first clause, extra is free, no bindings in None
    expect(freeVariables(expr)).toEqual(new Set(["val", "extra"]));
  });

  it("match — scrutinee free vars collected", () => {
    const expr: Expr = ["match", "x", [["Tag", "a"], "a"]];
    expect(freeVariables(expr)).toEqual(new Set(["x"]));
  });

  it("nested fn — inner binding shadows outer free", () => {
    // outer x is free, inner fn binds x again — inner x refs should not leak
    const expr: Expr = ["+", "x", ["fn", ["x"], ["+", "x", 1]]];
    expect(freeVariables(expr)).toEqual(new Set(["x"]));
  });

  it("shadowing: fn param shadows outer free var", () => {
    // x appears free at top level; inside fn, x is bound
    const expr: Expr = ["fn", ["x"], "x"];
    expect(freeVariables(expr)).toEqual(new Set());
  });

  it("free var inside fn body — fn params not counted as outer free vars", () => {
    // The fn introduces x; z is free in the body. Neither x nor z should appear
    // as free in the outer call unless they are also used outside the fn.
    const outer: Expr = ["call", ["fn", ["x"], ["+", "x", "z"]], "arg"];
    // outer free: z (inside fn body), arg (call argument)
    expect(freeVariables(outer)).toEqual(new Set(["z", "arg"]));
  });

  it("complex nesting: let inside fn", () => {
    const expr: Expr = ["fn", ["a"], ["let", [["b", "a"]], ["+", "b", "c"]]];
    // a bound by fn, b bound by let (using a), c is free
    expect(freeVariables(expr)).toEqual(new Set(["c"]));
  });

  it("empty array — no free vars", () => {
    expect(freeVariables([])).toEqual(new Set());
  });

  it("perform op — recurse into args, op string not a var", () => {
    const expr: Expr = ["perform", "Eff", "x"];
    // "perform" is the op — not a variable
    // "Eff" is the first arg (effect tag atom) — treated as a free var since it's a string atom
    // "x" is the second arg — also a free var
    expect(freeVariables(expr)).toEqual(new Set(["Eff", "x"]));
  });

  it("handle op — recurse into all args, op string not a var", () => {
    // ["handle", body, clause..., return-clause]
    const expr: Expr = [
      "handle",
      ["perform", "Id", "x"],
      [
        ["Id", "v", "k"],
        ["call", "k", "v"],
      ],
      [["return", "r"], "r"],
    ];
    // "handle" is the op — not a variable
    // All args are recursed into as plain subexpressions (no binding semantics)
    // body args: "Id" and "x" are free
    // clause [["Id","v","k"], ["call","k","v"]] is a nested array — recursed
    const free = freeVariables(expr);
    // "x" is free (payload in perform)
    expect(free.has("x")).toBe(true);
  });
});
