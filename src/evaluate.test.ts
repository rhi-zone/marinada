import { describe, it, expect } from "bun:test";
import { evaluate, EMPTY_ENV } from "./evaluate.ts";
import { evaluateModule } from "./module.ts";
import type { Value } from "./value.ts";
import type { Expr } from "./types.ts";
import type { Module } from "./types.ts";

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

function arr(...vals: Value[]): Value {
  return { kind: "array", value: vals };
}

function rec(obj: Record<string, Value>): Value {
  return { kind: "record", value: new Map(Object.entries(obj)) };
}

function variant(tag: string, ...fields: Value[]): Value {
  return { kind: "variant", tag, fields };
}

const NULL: Value = { kind: "null" };

// --- Tests ---

describe("atoms", () => {
  it("null", () => {
    expect(evaluate(null)).toEqual(ok(NULL));
  });

  it("boolean true", () => {
    expect(evaluate(true)).toEqual(ok(bool(true)));
  });

  it("boolean false", () => {
    expect(evaluate(false)).toEqual(ok(bool(false)));
  });

  it("integer literal becomes int with BigInt", () => {
    expect(evaluate(42)).toEqual(ok(int(42)));
    expect(evaluate(0)).toEqual(ok(int(0)));
    expect(evaluate(-7)).toEqual(ok(int(-7)));
  });

  it("float literal becomes float", () => {
    expect(evaluate(3.14)).toEqual(ok(float(3.14)));
    expect(evaluate(-0.5)).toEqual(ok(float(-0.5)));
  });

  it("string in non-op position is a variable lookup", () => {
    const env = EMPTY_ENV.extend({ x: int(99) });
    const r = evaluate("x", env);
    expect(r).toEqual(ok(int(99)));
  });

  it("undefined variable returns error", () => {
    expect(evaluate("missing")).toEqual(err("UNDEFINED_VAR"));
  });
});

describe("arithmetic", () => {
  it("int + int = int", () => {
    expect(evaluate(["+", 3, 5])).toEqual(ok(int(8)));
  });

  it("int - int = int", () => {
    expect(evaluate(["-", 10, 4])).toEqual(ok(int(6)));
  });

  it("int * int = int", () => {
    expect(evaluate(["*", 6, 7])).toEqual(ok(int(42)));
  });

  it("int / int = int (truncating)", () => {
    expect(evaluate(["/", 10, 3])).toEqual(ok(int(3)));
  });

  it("int % int = int", () => {
    expect(evaluate(["%", 10, 3])).toEqual(ok(int(1)));
  });

  it("float + float = float", () => {
    expect(evaluate(["+", 1.5, 2.5])).toEqual(ok(float(4.0)));
  });

  it("int + float = float", () => {
    const r = evalOk(["+", 3, 1.5]);
    expect(r.kind).toBe("float");
    expect((r as { kind: "float"; value: number }).value).toBeCloseTo(4.5);
  });

  it("float + int = float", () => {
    const r = evalOk(["+", 1.5, 3]);
    expect(r.kind).toBe("float");
  });

  it("division by zero (int) returns error", () => {
    expect(evaluate(["/", 5, 0])).toEqual(err("DIVISION_BY_ZERO"));
  });

  it("type error: arithmetic on non-number", () => {
    expect(evaluate(["+", "x", 1], EMPTY_ENV.extend({ x: str("hi") }))).toEqual(err("TYPE_ERROR"));
  });

  it("arity error: wrong number of args", () => {
    expect(evaluate(["+", 1, 2, 3])).toEqual(err("ARITY_ERROR"));
  });
});

describe("comparison", () => {
  it("== same ints", () => {
    expect(evaluate(["==", 5, 5])).toEqual(ok(bool(true)));
  });

  it("== different ints", () => {
    expect(evaluate(["==", 5, 6])).toEqual(ok(bool(false)));
  });

  it("!= ints", () => {
    expect(evaluate(["!=", 5, 6])).toEqual(ok(bool(true)));
  });

  it("== strings", () => {
    expect(
      evaluate(["==", "a", "b"], EMPTY_ENV.extend({ a: str("hello"), b: str("hello") })),
    ).toEqual(ok(bool(true)));
  });

  it("== null == null", () => {
    expect(evaluate(["==", null, null])).toEqual(ok(bool(true)));
  });

  it("== int vs float with same numeric value: different kinds = unequal", () => {
    // 5.0 in JS has Number.isInteger(5.0) === true, so it evaluates as int(5)
    // Both sides become int(5), so they are equal
    expect(evaluate(["==", 5, 5])).toEqual(ok(bool(true)));
    // To compare int vs float we need an actual float (one with decimal fraction)
    expect(evaluate(["==", 5, 5.5])).toEqual(ok(bool(false)));
  });

  it("< numbers", () => {
    expect(evaluate(["<", 3, 5])).toEqual(ok(bool(true)));
    expect(evaluate(["<", 5, 3])).toEqual(ok(bool(false)));
  });

  it("> numbers", () => {
    expect(evaluate([">", 5, 3])).toEqual(ok(bool(true)));
  });

  it("<= numbers", () => {
    expect(evaluate(["<=", 3, 3])).toEqual(ok(bool(true)));
    expect(evaluate(["<=", 4, 3])).toEqual(ok(bool(false)));
  });

  it(">= numbers", () => {
    expect(evaluate([">=", 3, 3])).toEqual(ok(bool(true)));
  });

  it("< type error: non-number", () => {
    expect(evaluate(["<", "a", "b"], EMPTY_ENV.extend({ a: str("x"), b: str("y") }))).toEqual(
      err("TYPE_ERROR"),
    );
  });
});

describe("logic", () => {
  it("and true true", () => {
    expect(evaluate(["and", true, true])).toEqual(ok(bool(true)));
  });

  it("and true false", () => {
    expect(evaluate(["and", true, false])).toEqual(ok(bool(false)));
  });

  it("or false true", () => {
    expect(evaluate(["or", false, true])).toEqual(ok(bool(true)));
  });

  it("or false false", () => {
    expect(evaluate(["or", false, false])).toEqual(ok(bool(false)));
  });

  it("not true", () => {
    expect(evaluate(["not", true])).toEqual(ok(bool(false)));
  });

  it("not false", () => {
    expect(evaluate(["not", false])).toEqual(ok(bool(true)));
  });

  it("and type error: non-bool", () => {
    expect(evaluate(["and", 1, true])).toEqual(err("TYPE_ERROR"));
  });
});

describe("control flow", () => {
  it("if true branch", () => {
    expect(evaluate(["if", true, 1, 2])).toEqual(ok(int(1)));
  });

  it("if false branch", () => {
    expect(evaluate(["if", false, 1, 2])).toEqual(ok(int(2)));
  });

  it("if type error: non-bool condition", () => {
    expect(evaluate(["if", 1, 1, 2])).toEqual(err("TYPE_ERROR"));
  });

  it("do evaluates all, returns last", () => {
    expect(evaluate(["do", 1, 2, 3])).toEqual(ok(int(3)));
  });

  it("do with single expr", () => {
    expect(evaluate(["do", 42])).toEqual(ok(int(42)));
  });
});

describe("let", () => {
  it("basic let binding", () => {
    expect(evaluate(["let", [["x", 5]], ["*", "x", "x"]])).toEqual(ok(int(25)));
  });

  it("multiple sequential bindings, later sees earlier", () => {
    // y = x + 1 should see x = 10
    expect(
      evaluate([
        "let",
        [
          ["x", 10],
          ["y", ["+", "x", 1]],
        ],
        "y",
      ]),
    ).toEqual(ok(int(11)));
  });

  it("let binding shadows outer env", () => {
    const env = EMPTY_ENV.extend({ x: int(100) });
    expect(evaluate(["let", [["x", 5]], "x"], env)).toEqual(ok(int(5)));
  });

  it("let body can use binding", () => {
    // String literals as values must be held in vars; " world" as a bare string
    // is a var reference, so we supply it in the env.
    const env = EMPTY_ENV.extend({ helloStr: str("hello"), worldStr: str(" world") });
    expect(
      evaluate(["let", [["greeting", "helloStr"]], ["concat", "greeting", "worldStr"]], env),
    ).toEqual(ok(str("hello world")));
  });

  it("undefined var in let value returns error", () => {
    expect(evaluate(["let", [["x", "missing"]], "x"])).toEqual(err("UNDEFINED_VAR"));
  });
});

describe("letrec", () => {
  it("simple recursive function: factorial", () => {
    const fact: Expr = [
      "letrec",
      [
        [
          "fact",
          ["fn", ["n"], ["if", ["==", "n", 0], 1, ["*", "n", ["call", "fact", ["-", "n", 1]]]]],
        ],
      ],
      ["call", "fact", 5],
    ];
    expect(evaluate(fact)).toEqual(ok(int(120)));
  });

  it("mutually recursive functions", () => {
    // isEven and isOdd via mutual recursion
    const expr: Expr = [
      "letrec",
      [
        ["isEven", ["fn", ["n"], ["if", ["==", "n", 0], true, ["call", "isOdd", ["-", "n", 1]]]]],
        ["isOdd", ["fn", ["n"], ["if", ["==", "n", 0], false, ["call", "isEven", ["-", "n", 1]]]]],
      ],
      ["call", "isEven", 4],
    ];
    expect(evaluate(expr)).toEqual(ok(bool(true)));
  });
});

describe("get / set", () => {
  // In Marinada, bare strings in non-op position are variable references.
  // To pass a string key, the string must be held in a variable.
  it("get field from record via string key variable", () => {
    const expr: Expr = ["get", "rec", "nameKey"];
    const env = EMPTY_ENV.extend({ rec: rec({ name: str("alice") }), nameKey: str("name") });
    expect(evaluate(expr, env)).toEqual(ok(str("alice")));
  });

  it("get missing field returns null", () => {
    const expr: Expr = ["get", "rec", "missingKey"];
    const env = EMPTY_ENV.extend({
      rec: rec({ name: str("alice") }),
      missingKey: str("noSuchField"),
    });
    expect(evaluate(expr, env)).toEqual(ok(NULL));
  });

  it("get array element by int index literal", () => {
    const expr: Expr = ["get", "a", 1];
    const env = EMPTY_ENV.extend({ a: arr(int(10), int(20), int(30)) });
    expect(evaluate(expr, env)).toEqual(ok(int(20)));
  });

  it("get out-of-bounds array returns null", () => {
    const expr: Expr = ["get", "a", 5];
    const env = EMPTY_ENV.extend({ a: arr(int(1)) });
    expect(evaluate(expr, env)).toEqual(ok(NULL));
  });

  it("get type error: string key on array", () => {
    const expr: Expr = ["get", "a", "notAnIndex"];
    const env = EMPTY_ENV.extend({
      a: arr(int(1)),
      notAnIndex: str("bad"),
    });
    expect(evaluate(expr, env)).toEqual(err("TYPE_ERROR"));
  });

  it("set field on record returns new record", () => {
    const expr: Expr = ["set", "rec", "ageKey", 30];
    const env = EMPTY_ENV.extend({ rec: rec({ name: str("bob") }), ageKey: str("age") });
    const result = evalOk(expr, env);
    expect(result.kind).toBe("record");
    const m = (result as { kind: "record"; value: Map<string, Value> }).value;
    expect(m.get("age")).toEqual(int(30));
    expect(m.get("name")).toEqual(str("bob"));
  });

  it("set on array returns new array", () => {
    const expr: Expr = ["set", "a", 1, 99];
    const env = EMPTY_ENV.extend({ a: arr(int(0), int(1), int(2)) });
    const result = evalOk(expr, env);
    expect(result).toEqual(arr(int(0), int(99), int(2)));
  });

  it("get-in nested record via path variable", () => {
    const inner = rec({ z: int(42) });
    const outer = rec({ inner });
    // Path must be an array value — held in a variable
    const path = arr(str("inner"), str("z"));
    const env = EMPTY_ENV.extend({ obj: outer, path });
    const expr: Expr = ["get-in", "obj", "path"];
    expect(evaluate(expr, env)).toEqual(ok(int(42)));
  });

  it("set-in nested via path variable", () => {
    const inner = rec({ z: int(0) });
    const outer = rec({ inner });
    const path = arr(str("inner"), str("z"));
    const env = EMPTY_ENV.extend({ obj: outer, path });
    const expr: Expr = ["set-in", "obj", "path", 99];
    const result = evalOk(expr, env);
    expect(result.kind).toBe("record");
    const newInner = (result as { kind: "record"; value: Map<string, Value> }).value.get("inner")!;
    expect((newInner as { kind: "record"; value: Map<string, Value> }).value.get("z")).toEqual(
      int(99),
    );
  });
});

describe("type ops", () => {
  it("is int true", () => {
    expect(evaluate(["is", "int", 42])).toEqual(ok(bool(true)));
  });

  it("is int false for float", () => {
    expect(evaluate(["is", "int", 3.14])).toEqual(ok(bool(false)));
  });

  it("is string true", () => {
    expect(evaluate(["is", "string", "x"], EMPTY_ENV.extend({ x: str("hi") }))).toEqual(
      ok(bool(true)),
    );
  });

  it("is null", () => {
    expect(evaluate(["is", "null", null])).toEqual(ok(bool(true)));
  });

  it("as correct type passes through", () => {
    expect(evaluate(["as", "int", 42])).toEqual(ok(int(42)));
  });

  it("as wrong type returns error", () => {
    expect(evaluate(["as", "int", 3.14])).toEqual(err("TYPE_ERROR"));
  });

  it("untyped is identity", () => {
    expect(evaluate(["untyped", 42])).toEqual(ok(int(42)));
  });
});

describe("collections", () => {
  it("count array", () => {
    const env = EMPTY_ENV.extend({ nums: arr(int(1), int(2), int(3)) });
    expect(evaluate(["count", "nums"], env)).toEqual(ok(int(3)));
  });

  it("count record", () => {
    const env = EMPTY_ENV.extend({ rec: rec({ a: int(1), b: int(2) }) });
    expect(evaluate(["count", "rec"], env)).toEqual(ok(int(2)));
  });

  it("merge records, r2 overrides r1", () => {
    const r1 = rec({ a: int(1), b: int(2) });
    const r2 = rec({ b: int(99), c: int(3) });
    const env = EMPTY_ENV.extend({ r1, r2 });
    const result = evalOk(["merge", "r1", "r2"], env);
    expect(result.kind).toBe("record");
    const m = (result as { kind: "record"; value: Map<string, Value> }).value;
    expect(m.get("a")).toEqual(int(1));
    expect(m.get("b")).toEqual(int(99));
    expect(m.get("c")).toEqual(int(3));
  });

  it("keys returns array of strings", () => {
    const env = EMPTY_ENV.extend({ rec: rec({ a: int(1), b: int(2) }) });
    const result = evalOk(["keys", "rec"], env);
    expect(result.kind).toBe("array");
    const keys = (result as { kind: "array"; value: Value[] }).value.map(
      (v) => (v as { kind: "string"; value: string }).value,
    );
    expect(keys.sort()).toEqual(["a", "b"]);
  });

  it("vals returns array of values", () => {
    const env = EMPTY_ENV.extend({ rec: rec({ x: int(10) }) });
    const result = evalOk(["vals", "rec"], env);
    expect(result).toEqual(arr(int(10)));
  });
});

describe("string ops", () => {
  it("concat strings", () => {
    const env = EMPTY_ENV.extend({ a: str("hello"), b: str(" world") });
    expect(evaluate(["concat", "a", "b"], env)).toEqual(ok(str("hello world")));
  });

  it("concat multiple strings", () => {
    const env = EMPTY_ENV.extend({ a: str("a"), b: str("b"), c: str("c") });
    expect(evaluate(["concat", "a", "b", "c"], env)).toEqual(ok(str("abc")));
  });

  it("slice string", () => {
    const env = EMPTY_ENV.extend({ s: str("hello world") });
    expect(evaluate(["slice", "s", 0, 5], env)).toEqual(ok(str("hello")));
  });

  it("to-string int", () => {
    expect(evaluate(["to-string", 42])).toEqual(ok(str("42")));
  });

  it("to-string float", () => {
    expect(evaluate(["to-string", 3.14])).toEqual(ok(str("3.14")));
  });

  it("to-string bool", () => {
    expect(evaluate(["to-string", true])).toEqual(ok(str("true")));
  });

  it("to-string null", () => {
    expect(evaluate(["to-string", null])).toEqual(ok(str("null")));
  });

  it("parse-number integer string", () => {
    const env = EMPTY_ENV.extend({ s: str("42") });
    expect(evaluate(["parse-number", "s"], env)).toEqual(ok(int(42)));
  });

  it("parse-number float string", () => {
    const env = EMPTY_ENV.extend({ s: str("3.14") });
    const result = evalOk(["parse-number", "s"], env);
    expect(result.kind).toBe("float");
    expect((result as { kind: "float"; value: number }).value).toBeCloseTo(3.14);
  });

  it("parse-number invalid returns null", () => {
    const env = EMPTY_ENV.extend({ s: str("nope") });
    expect(evaluate(["parse-number", "s"], env)).toEqual(ok(NULL));
  });

  it("concat type error: non-string", () => {
    const env = EMPTY_ENV.extend({ a: str("hi"), b: int(5) });
    expect(evaluate(["concat", "a", "b"], env)).toEqual(err("TYPE_ERROR"));
  });
});

describe("fn and call", () => {
  it("create and call a function", () => {
    const expr: Expr = ["call", ["fn", ["x", "y"], ["+", "x", "y"]], 3, 4];
    expect(evaluate(expr)).toEqual(ok(int(7)));
  });

  it("closure captures environment", () => {
    // let adder = fn(x) -> x + base
    const expr: Expr = [
      "let",
      [
        ["base", 10],
        ["adder", ["fn", ["x"], ["+", "x", "base"]]],
      ],
      ["call", "adder", 5],
    ];
    expect(evaluate(expr)).toEqual(ok(int(15)));
  });

  it("fn arity error", () => {
    const expr: Expr = ["call", ["fn", ["x"], "x"], 1, 2];
    expect(evaluate(expr)).toEqual(err("ARITY_ERROR"));
  });

  it("call non-fn returns TYPE_ERROR", () => {
    const env = EMPTY_ENV.extend({ x: int(5) });
    expect(evaluate(["call", "x"], env)).toEqual(err("TYPE_ERROR"));
  });

  it("fn with typed params (name only extracted)", () => {
    const expr: Expr = ["call", ["fn", [["x", "int"]], ["*", "x", 2]], 7];
    expect(evaluate(expr)).toEqual(ok(int(14)));
  });

  it("fn-once evaluates identically to fn at runtime", () => {
    // fn-once is a linearity-only annotation; at runtime it behaves like fn.
    const expr: Expr = ["call", ["fn-once", ["x", "y"], ["+", "x", "y"]], 3, 4];
    expect(evaluate(expr)).toEqual(ok(int(7)));
  });

  it("fn-once closure captures environment", () => {
    const expr: Expr = [
      "let",
      [
        ["base", 10],
        ["adder", ["fn-once", ["x"], ["+", "x", "base"]]],
      ],
      ["call", "adder", 5],
    ];
    expect(evaluate(expr)).toEqual(ok(int(15)));
  });
});

describe("DU variants and match", () => {
  it("construct a zero-field variant", () => {
    expect(evaluate(["Red"])).toEqual(ok(variant("Red")));
  });

  it("construct a variant with fields", () => {
    expect(evaluate(["Circle", 1.5])).toEqual(ok(variant("Circle", float(1.5))));
  });

  it("match on variant", () => {
    const env = EMPTY_ENV.extend({ shape: variant("Circle", float(1.0)) });
    const expr: Expr = [
      "match",
      "shape",
      [
        ["Circle", "r"],
        ["*", "r", "r"],
      ],
      [
        ["Rect", "w", "h"],
        ["*", "w", "h"],
      ],
    ];
    const r = evalOk(expr, env);
    expect(r.kind).toBe("float");
    expect((r as { kind: "float"; value: number }).value).toBeCloseTo(1.0);
  });

  it("match selects correct branch", () => {
    const env = EMPTY_ENV.extend({ shape: variant("Rect", float(3.0), float(4.0)) });
    const expr: Expr = [
      "match",
      "shape",
      [
        ["Circle", "r"],
        ["*", "r", "r"],
      ],
      [
        ["Rect", "w", "h"],
        ["*", "w", "h"],
      ],
    ];
    const r = evalOk(expr, env);
    expect(r.kind).toBe("float");
    expect((r as { kind: "float"; value: number }).value).toBeCloseTo(12.0);
  });

  it("match zero-field variant", () => {
    const env = EMPTY_ENV.extend({ color: variant("Red") });
    const expr: Expr = ["match", "color", [["Red"], 1], [["Green"], 2], [["Blue"], 3]];
    expect(evaluate(expr, env)).toEqual(ok(int(1)));
  });

  it("non-exhaustive match returns error", () => {
    const env = EMPTY_ENV.extend({ shape: variant("Triangle") });
    const expr: Expr = ["match", "shape", [["Circle", "r"], "r"]];
    expect(evaluate(expr, env)).toEqual(err("NON_EXHAUSTIVE_MATCH"));
  });

  it("match with recursive DU", () => {
    // option: Some(v) | None
    const some = variant("Some", int(42));
    const env = EMPTY_ENV.extend({ opt: some });
    const expr: Expr = ["match", "opt", [["Some", "v"], "v"], [["None"], 0]];
    expect(evaluate(expr, env)).toEqual(ok(int(42)));
  });

  it("DU round-trip via letrec and match", () => {
    // Build a linked list and sum it
    // List = Cons(head, tail) | Nil
    const list = variant(
      "Cons",
      int(1),
      variant("Cons", int(2), variant("Cons", int(3), variant("Nil"))),
    );
    const env = EMPTY_ENV.extend({ myList: list });
    const expr: Expr = [
      "letrec",
      [
        [
          "sum",
          [
            "fn",
            ["lst"],
            [
              "match",
              "lst",
              [["Nil"], 0],
              [
                ["Cons", "head", "tail"],
                ["+", "head", ["call", "sum", "tail"]],
              ],
            ],
          ],
        ],
      ],
      ["call", "sum", "myList"],
    ];
    expect(evaluate(expr, env)).toEqual(ok(int(6)));
  });
});

describe("equality", () => {
  it("record equality", () => {
    const r1 = rec({ a: int(1), b: str("x") });
    const r2 = rec({ a: int(1), b: str("x") });
    const env = EMPTY_ENV.extend({ r1, r2 });
    expect(evaluate(["==", "r1", "r2"], env)).toEqual(ok(bool(true)));
  });

  it("array equality", () => {
    const a1 = arr(int(1), int(2));
    const a2 = arr(int(1), int(2));
    const env = EMPTY_ENV.extend({ a1, a2 });
    expect(evaluate(["==", "a1", "a2"], env)).toEqual(ok(bool(true)));
  });

  it("variant equality", () => {
    const v1 = variant("Some", int(1));
    const v2 = variant("Some", int(1));
    const env = EMPTY_ENV.extend({ v1, v2 });
    expect(evaluate(["==", "v1", "v2"], env)).toEqual(ok(bool(true)));
  });

  it("variant inequality different tag", () => {
    const v1 = variant("Some", int(1));
    const v2 = variant("None");
    const env = EMPTY_ENV.extend({ v1, v2 });
    expect(evaluate(["==", "v1", "v2"], env)).toEqual(ok(bool(false)));
  });
});

describe("error handling", () => {
  it("unknown op returns UNKNOWN_OP", () => {
    expect(evaluate(["nonexistent-op", 1])).toEqual(err("UNKNOWN_OP"));
  });

  it("empty array returns error", () => {
    expect(evaluate([])).toEqual(err("UNKNOWN_OP"));
  });

  it("error propagates path from nested expr", () => {
    const r = evaluate(["+", ["missing-var"], 1]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.path[0]).toBe(1);
    }
  });
});

describe("complex programs", () => {
  it("fibonacci via letrec", () => {
    const expr: Expr = [
      "letrec",
      [
        [
          "fib",
          [
            "fn",
            ["n"],
            [
              "if",
              ["<=", "n", 1],
              "n",
              ["+", ["call", "fib", ["-", "n", 1]], ["call", "fib", ["-", "n", 2]]],
            ],
          ],
        ],
      ],
      ["call", "fib", 10],
    ];
    expect(evaluate(expr)).toEqual(ok(int(55)));
  });

  it("map then filter then reduce (via lib:std)", () => {
    // Double [1..5], keep evens, sum → doubled: 2,4,6,8,10; evens: 2,4,6,8,10; sum: 30
    const module: Module = {
      imports: [{ from: "lib:std", import: ["map", "filter", "reduce"] }],
      main: [
        "call",
        "reduce",
        ["fn", ["acc", "x"], ["+", "acc", "x"]],
        0,
        [
          "call",
          "filter",
          ["fn", ["x"], ["==", ["%", "x", 2], 0]],
          ["call", "map", ["fn", ["x"], ["*", "x", 2]], ["array", 1, 2, 3, 4, 5]],
        ],
      ],
    };
    const r = evaluateModule(module);
    expect(r).toEqual(ok(int(30)));
  });

  it("nested let with closures", () => {
    const expr: Expr = [
      "let",
      [["make-adder", ["fn", ["n"], ["fn", ["x"], ["+", "n", "x"]]]]],
      ["let", [["add5", ["call", "make-adder", 5]]], ["call", "add5", 10]],
    ];
    expect(evaluate(expr)).toEqual(ok(int(15)));
  });

  it("to-string on int in concat", () => {
    const expr: Expr = ["concat", "hello", ["to-string", 42]];
    const env = EMPTY_ENV.extend({ hello: str("hello") });
    expect(evaluate(expr, env)).toEqual(ok(str("hello42")));
  });
});

// Helper to allow env parameter in evalOk
function evalOk(expr: Expr, env = EMPTY_ENV): Value {
  const r = evaluate(expr, env);
  if (!r.ok) throw new Error(`Expected ok, got error: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe("array primitives", () => {
  it("array constructs empty array", () => {
    expect(evaluate(["array"])).toEqual(ok(arr()));
  });

  it("array constructs from args", () => {
    expect(evaluate(["array", 1, 2, 3])).toEqual(ok(arr(int(1), int(2), int(3))));
  });

  it("array-get returns element at index", () => {
    const env = EMPTY_ENV.extend({ a: arr(int(10), int(20), int(30)) });
    expect(evaluate(["array-get", "a", 1], env)).toEqual(ok(int(20)));
  });

  it("array-get out of bounds returns null", () => {
    const env = EMPTY_ENV.extend({ a: arr(int(1)) });
    expect(evaluate(["array-get", "a", 5], env)).toEqual(ok(NULL));
  });

  it("array-push appends element", () => {
    const env = EMPTY_ENV.extend({ a: arr(int(1), int(2)) });
    expect(evaluate(["array-push", "a", 3], env)).toEqual(ok(arr(int(1), int(2), int(3))));
  });

  it("array-slice with start and end", () => {
    const env = EMPTY_ENV.extend({ a: arr(int(0), int(1), int(2), int(3), int(4)) });
    expect(evaluate(["array-slice", "a", 1, 3], env)).toEqual(ok(arr(int(1), int(2))));
  });

  it("array-slice with start only", () => {
    const env = EMPTY_ENV.extend({ a: arr(int(0), int(1), int(2)) });
    expect(evaluate(["array-slice", "a", 1], env)).toEqual(ok(arr(int(1), int(2))));
  });
});

describe("record primitives", () => {
  it("record-get returns value", () => {
    const env = EMPTY_ENV.extend({ r: rec({ x: int(42) }), k: str("x") });
    expect(evaluate(["record-get", "r", "k"], env)).toEqual(ok(int(42)));
  });

  it("record-get missing key returns null", () => {
    const env = EMPTY_ENV.extend({ r: rec({ x: int(1) }), k: str("z") });
    expect(evaluate(["record-get", "r", "k"], env)).toEqual(ok(NULL));
  });

  it("record-set returns new record with field set", () => {
    const env = EMPTY_ENV.extend({ r: rec({ x: int(1) }), k: str("y") });
    const result = evalOk(["record-set", "r", "k", 99], env);
    expect(result.kind).toBe("record");
    const m = (result as { kind: "record"; value: Map<string, Value> }).value;
    expect(m.get("y")).toEqual(int(99));
    expect(m.get("x")).toEqual(int(1));
  });

  it("record-del removes key", () => {
    const env = EMPTY_ENV.extend({ r: rec({ a: int(1), b: int(2) }), k: str("a") });
    const result = evalOk(["record-del", "r", "k"], env);
    expect(result.kind).toBe("record");
    const m = (result as { kind: "record"; value: Map<string, Value> }).value;
    expect(m.has("a")).toBe(false);
    expect(m.get("b")).toEqual(int(2));
  });

  it("record-keys returns keys", () => {
    const env = EMPTY_ENV.extend({ r: rec({ a: int(1), b: int(2) }) });
    const result = evalOk(["record-keys", "r"], env);
    expect(result.kind).toBe("array");
    const keys = (result as { kind: "array"; value: Value[] }).value.map(
      (v) => (v as { kind: "string"; value: string }).value,
    );
    expect(keys.sort()).toEqual(["a", "b"]);
  });

  it("record-vals returns values", () => {
    const env = EMPTY_ENV.extend({ r: rec({ x: int(7) }) });
    expect(evaluate(["record-vals", "r"], env)).toEqual(ok(arr(int(7))));
  });

  it("record-merge merges two records", () => {
    const env = EMPTY_ENV.extend({ r1: rec({ a: int(1) }), r2: rec({ b: int(2) }) });
    const result = evalOk(["record-merge", "r1", "r2"], env);
    expect(result.kind).toBe("record");
    const m = (result as { kind: "record"; value: Map<string, Value> }).value;
    expect(m.get("a")).toEqual(int(1));
    expect(m.get("b")).toEqual(int(2));
  });
});

describe("string primitives", () => {
  it("str-len returns length", () => {
    const env = EMPTY_ENV.extend({ s: str("hello") });
    expect(evaluate(["str-len", "s"], env)).toEqual(ok(int(5)));
  });

  it("str-get returns codepoint", () => {
    const env = EMPTY_ENV.extend({ s: str("ABC") });
    expect(evaluate(["str-get", "s", 0], env)).toEqual(ok(int(65)));
  });

  it("str-get out of bounds returns null", () => {
    const env = EMPTY_ENV.extend({ s: str("hi") });
    expect(evaluate(["str-get", "s", 10], env)).toEqual(ok(NULL));
  });

  it("str-concat concatenates two strings", () => {
    const env = EMPTY_ENV.extend({ a: str("foo"), b: str("bar") });
    expect(evaluate(["str-concat", "a", "b"], env)).toEqual(ok(str("foobar")));
  });

  it("str-slice returns substring", () => {
    const env = EMPTY_ENV.extend({ s: str("hello world") });
    expect(evaluate(["str-slice", "s", 0, 5], env)).toEqual(ok(str("hello")));
  });

  it("str-cmp less than returns -1", () => {
    const env = EMPTY_ENV.extend({ a: str("apple"), b: str("banana") });
    expect(evaluate(["str-cmp", "a", "b"], env)).toEqual(ok(int(-1)));
  });

  it("str-cmp equal returns 0", () => {
    const env = EMPTY_ENV.extend({ a: str("same"), b: str("same") });
    expect(evaluate(["str-cmp", "a", "b"], env)).toEqual(ok(int(0)));
  });

  it("str-cmp greater than returns 1", () => {
    const env = EMPTY_ENV.extend({ a: str("z"), b: str("a") });
    expect(evaluate(["str-cmp", "a", "b"], env)).toEqual(ok(int(1)));
  });

  it("parse-int valid string", () => {
    const env = EMPTY_ENV.extend({ s: str("42") });
    expect(evaluate(["parse-int", "s"], env)).toEqual(ok(int(42)));
  });

  it("parse-int invalid string returns null", () => {
    const env = EMPTY_ENV.extend({ s: str("abc") });
    expect(evaluate(["parse-int", "s"], env)).toEqual(ok(NULL));
  });

  it("parse-float valid string", () => {
    const env = EMPTY_ENV.extend({ s: str("3.14") });
    const result = evalOk(["parse-float", "s"], env);
    expect(result.kind).toBe("float");
    expect((result as { kind: "float"; value: number }).value).toBeCloseTo(3.14);
  });

  it("parse-float invalid string returns null", () => {
    const env = EMPTY_ENV.extend({ s: str("nope") });
    expect(evaluate(["parse-float", "s"], env)).toEqual(ok(NULL));
  });
});

describe("math primitives", () => {
  it("floor of float", () => {
    expect(evaluate(["floor", 3.7])).toEqual(ok(float(3.0)));
  });

  it("floor of int is identity", () => {
    expect(evaluate(["floor", 5])).toEqual(ok(int(5)));
  });

  it("ceil of float", () => {
    expect(evaluate(["ceil", 3.2])).toEqual(ok(float(4.0)));
  });

  it("round of float", () => {
    expect(evaluate(["round", 3.5])).toEqual(ok(float(4.0)));
  });

  it("abs of negative int", () => {
    expect(evaluate(["abs", -7])).toEqual(ok(int(7)));
  });

  it("abs of negative float", () => {
    expect(evaluate(["abs", -2.5])).toEqual(ok(float(2.5)));
  });

  it("min of two ints", () => {
    expect(evaluate(["min", 3, 5])).toEqual(ok(int(3)));
  });

  it("max of two ints", () => {
    expect(evaluate(["max", 3, 5])).toEqual(ok(int(5)));
  });

  it("pow returns float", () => {
    const result = evalOk(["pow", 2, 10]);
    expect(result.kind).toBe("float");
    expect((result as { kind: "float"; value: number }).value).toBeCloseTo(1024);
  });

  it("sqrt of float", () => {
    const result = evalOk(["sqrt", 4]);
    expect(result.kind).toBe("float");
    expect((result as { kind: "float"; value: number }).value).toBeCloseTo(2.0);
  });

  it("int->float converts int to float", () => {
    expect(evaluate(["int->float", 5])).toEqual(ok(float(5.0)));
  });

  it("float->int truncates toward zero", () => {
    expect(evaluate(["float->int", 3.9])).toEqual(ok(int(3)));
    expect(evaluate(["float->int", -3.9])).toEqual(ok(int(-3)));
  });
});

describe("bitwise primitives", () => {
  it("bit-and", () => {
    expect(evaluate(["bit-and", 12, 10])).toEqual(ok(int(8)));
  });

  it("bit-or", () => {
    expect(evaluate(["bit-or", 5, 3])).toEqual(ok(int(7)));
  });

  it("bit-xor", () => {
    expect(evaluate(["bit-xor", 5, 3])).toEqual(ok(int(6)));
  });

  it("bit-not", () => {
    const result = evalOk(["bit-not", 0]);
    expect(result.kind).toBe("int");
    expect((result as { kind: "int"; value: bigint }).value).toBe(~0n);
  });

  it("bit-shl shifts left", () => {
    expect(evaluate(["bit-shl", 1, 4])).toEqual(ok(int(16)));
  });

  it("bit-shr shifts right", () => {
    expect(evaluate(["bit-shr", 16, 2])).toEqual(ok(int(4)));
  });

  it("bit-and type error: non-int", () => {
    const env = EMPTY_ENV.extend({ f: float(3.5) });
    expect(evaluate(["bit-and", 5, "f"], env)).toEqual(err("TYPE_ERROR"));
  });
});
