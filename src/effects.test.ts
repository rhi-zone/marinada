import { describe, it, expect } from "bun:test";
import { evaluate } from "./evaluate.ts";
import type { Value } from "./value.ts";
import type { Expr } from "./types.ts";

// --- Helpers ---

function ok(value: Value): { ok: true; value: Value } {
  return { ok: true, value };
}

function errCode(code: string) {
  return expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) });
}

function int(n: number | bigint): Value {
  return { kind: "int", value: typeof n === "bigint" ? n : BigInt(n) };
}

// --- Tests ---

describe("algebraic effects", () => {
  it("1. basic perform/handle: handler returns payload without calling k", () => {
    // ["handle", ["perform", "Greeting", 42],
    //   [["Greeting", "msg", "k"], "msg"],
    //   [["return", "x"], "x"]]
    // → the handler intercepts "Greeting", binds msg=42, returns msg (ignores k)
    const expr: Expr = [
      "handle",
      ["perform", "Greeting", 42],
      [["Greeting", "msg", "k"], "msg"],
      [["return", "x"], "x"],
    ];
    expect(evaluate(expr)).toEqual(ok(int(42)));
  });

  it("2. unhandled effect: evaluate returns UNHANDLED_EFFECT error", () => {
    const expr: Expr = ["perform", "Boom", null];
    expect(evaluate(expr)).toEqual(errCode("UNHANDLED_EFFECT"));
  });

  it("3. effect propagates through non-matching handler to outer handler", () => {
    // Inner handler only handles "A"; performing "B" propagates to outer handler
    const expr: Expr = [
      "handle",
      [
        "handle",
        ["perform", "B", 99],
        [["A", "v", "k"], "v"], // does not match "B"
        [["return", "x"], "x"],
      ],
      [["B", "v", "k"], "v"], // outer catches "B"
      [["return", "x"], "x"],
    ];
    expect(evaluate(expr)).toEqual(ok(int(99)));
  });

  it("4. one-shot abort pattern: handler returns payload, k never called", () => {
    // ["handle", ["perform", "Abort", 42],
    //   [["Abort", "val", "k"], "val"],
    //   [["return", "x"], "x"]]
    // → returns 42
    const expr: Expr = [
      "handle",
      ["perform", "Abort", 42],
      [["Abort", "val", "k"], "val"],
      [["return", "x"], "x"],
    ];
    expect(evaluate(expr)).toEqual(ok(int(42)));
  });

  it("5. continuation called once: computation resumes with supplied value", () => {
    // ["handle",
    //   ["do", ["perform", "Ask", null], "+", ...]
    //   but more precisely: ["+", ["perform", "Ask", null], 5]
    //   handler resumes k with 10; result = 10 + 5 = 15
    const expr: Expr = [
      "handle",
      ["+", ["perform", "Ask", null], 5],
      [
        ["Ask", "_", "k"],
        ["call", "k", 10],
      ],
      [["return", "x"], "x"],
    ];
    expect(evaluate(expr)).toEqual(ok(int(15)));
  });

  it("6. multi-shot (Yield/sum): handler sums all yielded values via continuation", () => {
    // Inner expr yields 1, 2, 3.
    // Handler: for each Yield, add v to the result of calling k (which triggers the next Yield).
    // Return clause: return 0 (base case).
    // Result: 1 + (2 + (3 + 0)) = 6
    const expr: Expr = [
      "handle",
      ["do", ["perform", "Yield", 1], ["perform", "Yield", 2], ["perform", "Yield", 3]],
      [
        ["Yield", "v", "k"],
        ["let", [["rest", ["call", "k", null]]], ["+", "v", "rest"]],
      ],
      [["return", "_"], 0],
    ];
    expect(evaluate(expr)).toEqual(ok(int(6)));
  });

  it("7. nested handlers: inner handles one effect, outer handles another", () => {
    // Perform both "Inner" and "Outer" inside nested handles.
    // The do expression performs Inner then Outer; inner handler handles Inner,
    // the effect for Outer passes through to the outer handler.
    // Both handlers resume via k.
    const expr: Expr = [
      "handle",
      [
        "handle",
        ["do", ["perform", "Inner", 3], ["perform", "Outer", 7]],
        [
          ["Inner", "_", "k"],
          ["call", "k", 10],
        ],
        [["return", "x"], "x"],
      ],
      [
        ["Outer", "_", "k"],
        ["call", "k", 20],
      ],
      [["return", "x"], "x"],
    ];
    // do returns last expr: perform "Outer" resumes with 20 → 20
    expect(evaluate(expr)).toEqual(ok(int(20)));
  });

  it("8. effect in letrec: effects work inside recursive functions", () => {
    // Recursive function that yields each element of a counter down from n to 1.
    // We sum all yielded values via the continuation pattern.
    // countdown(3) performs Yield 3, then countdown(2) performs Yield 2, then Yield 1, then done.
    // Sum: 3 + 2 + 1 = 6
    const expr: Expr = [
      "handle",
      [
        "letrec",
        [
          [
            "countdown",
            [
              "fn",
              ["n"],
              [
                "if",
                ["==", "n", 0],
                null,
                ["do", ["perform", "Yield", "n"], ["call", "countdown", ["-", "n", 1]]],
              ],
            ],
          ],
        ],
        ["call", "countdown", 3],
      ],
      [
        ["Yield", "v", "k"],
        ["let", [["rest", ["call", "k", null]]], ["+", "v", "rest"]],
      ],
      [["return", "_"], 0],
    ];
    expect(evaluate(expr)).toEqual(ok(int(6)));
  });

  it("9. return clause transforms the final value", () => {
    // No effect performed; the inner expression evaluates to 10.
    // The return clause multiplies it by 2, producing 20.
    const expr: Expr = [
      "handle",
      ["+", 5, 5],
      [
        ["return", "x"],
        ["*", "x", 2],
      ],
    ];
    expect(evaluate(expr)).toEqual(ok(int(20)));
  });

  it("9b. handle with no clauses passes value through", () => {
    // handle with no clauses and no return clause: inner value passes through unchanged
    const expr: Expr = ["handle", ["+", 3, 4]];
    expect(evaluate(expr)).toEqual(ok(int(7)));
  });

  it("continuation value is callable via call op", () => {
    // Ensure that k inside a handler is accessible and callable.
    // The handler for "Get" resumes k with 42; the inner expression
    // returns whatever "Get" resumes with, plus 1.
    const expr: Expr = [
      "handle",
      ["+", ["perform", "Get", null], 1],
      [
        ["Get", "_", "k"],
        ["call", "k", 42],
      ],
      [["return", "x"], "x"],
    ];
    // performs "Get", resumes with 42, do 42 + 1 = 43
    expect(evaluate(expr)).toEqual(ok(int(43)));
  });

  it("unhandled effect message contains the effect tag", () => {
    const result = evaluate(["perform", "MyCustomEffect", null]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNHANDLED_EFFECT");
      expect(result.error.message).toContain("MyCustomEffect");
    }
  });

  it("perform payload evaluates before yielding", () => {
    // The payload expression ["+", 3, 4] should evaluate to 7 before performing
    const expr: Expr = [
      "handle",
      ["perform", "Emit", ["+", 3, 4]],
      [["Emit", "v", "k"], "v"],
      [["return", "x"], "x"],
    ];
    expect(evaluate(expr)).toEqual(ok(int(7)));
  });
});
