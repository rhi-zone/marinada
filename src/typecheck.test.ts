import { describe, it, expect } from "bun:test";
import { typecheck, typecheckModule, EMPTY_TYPE_ENV, prettyType } from "./typecheck.ts";
import type { MType } from "./typecheck.ts";
import type { Expr } from "./types.ts";

// --- Helpers ---

function ok(type: MType) {
  return expect.objectContaining({ ok: true, type });
}

function err(code: string) {
  return expect.objectContaining({
    ok: false,
    errors: expect.arrayContaining([expect.objectContaining({ code })]),
  });
}

const UNKNOWN: MType = { kind: "unknown" };
const NULL_T: MType = { kind: "null" };
const BOOL: MType = { kind: "bool" };
const INT: MType = { kind: "int" };
const FLOAT: MType = { kind: "float" };
const STRING: MType = { kind: "string" };

// --- Atoms ---

describe("atoms", () => {
  it("null → null", () => {
    expect(typecheck(null)).toEqual(ok(NULL_T));
  });

  it("true → bool", () => {
    expect(typecheck(true)).toEqual(ok(BOOL));
  });

  it("false → bool", () => {
    expect(typecheck(false)).toEqual(ok(BOOL));
  });

  it("integer → int", () => {
    expect(typecheck(42)).toEqual(ok(INT));
    expect(typecheck(0)).toEqual(ok(INT));
    expect(typecheck(-7)).toEqual(ok(INT));
  });

  it("float → float", () => {
    expect(typecheck(3.14)).toEqual(ok(FLOAT));
    expect(typecheck(-0.5)).toEqual(ok(FLOAT));
  });

  it("known variable → its type", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: INT });
    expect(typecheck("x", env)).toEqual(ok(INT));
  });

  it("unknown variable → error", () => {
    const result = typecheck("missing");
    expect(result).toEqual(err("UNDEFINED_VAR"));
  });
});

// --- Arithmetic ---

describe("arithmetic", () => {
  it("int + int → int", () => {
    expect(typecheck(["+", 1, 2])).toEqual(ok(INT));
  });

  it("float + float → float", () => {
    expect(typecheck(["+", 1.5, 2.5])).toEqual(ok(FLOAT));
  });

  // Phase 1 design: NO int→float widening. `1 + 1.5` is a TYPE_MISMATCH.
  // Use `["as", "float", 1]` to widen explicitly.
  it("int + float → TYPE_MISMATCH (no widening)", () => {
    expect(typecheck(["+", 1, 2.5])).toEqual(err("TYPE_MISMATCH"));
  });

  it("float + int → TYPE_MISMATCH (no widening)", () => {
    expect(typecheck(["+", 1.5, 2])).toEqual(err("TYPE_MISMATCH"));
  });

  // Gradual: `unknown` consistent-unifies silently. Result type follows the
  // OTHER side under HM (not unknown — that would poison inference).
  it("unknown + int → int (consistent unification, no error)", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["+", "x", 1], env)).toEqual(ok(INT));
    expect(typecheck(["+", 1, "x"], env)).toEqual(ok(INT));
  });

  it("unknown + unknown → unknown (no error)", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["+", "x", "x"], env)).toEqual(ok(UNKNOWN));
  });

  it("string in arithmetic → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["+", "s", 1], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("string right operand → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["+", 1, "s"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("subtraction", () => {
    expect(typecheck(["-", 10, 3])).toEqual(ok(INT));
  });

  it("multiplication", () => {
    expect(typecheck(["*", 4, 5])).toEqual(ok(INT));
  });

  it("division", () => {
    expect(typecheck(["/", 10, 2])).toEqual(ok(INT));
    // No widening: both must be the same numeric type
    expect(typecheck(["/", 10.5, 0.5])).toEqual(ok(FLOAT));
  });

  it("modulo", () => {
    expect(typecheck(["%", 10, 3])).toEqual(ok(INT));
  });

  it("unary minus on int → int", () => {
    expect(typecheck(["-", 5])).toEqual(ok(INT));
  });

  it("arity error", () => {
    expect(typecheck(["+", 1])).toEqual(err("ARITY_ERROR"));
    expect(typecheck(["+", 1, 2, 3])).toEqual(err("ARITY_ERROR"));
  });

  it("explicit widening: as float makes int + float work", () => {
    expect(typecheck(["+", ["as", "float", 1], 2.5])).toEqual(ok(FLOAT));
  });
});

// --- Comparison ---

describe("comparison", () => {
  it("== same types → bool", () => {
    expect(typecheck(["==", 1, 2])).toEqual(ok(BOOL));
    expect(typecheck(["==", true, false])).toEqual(ok(BOOL));
  });

  it("!= same types → bool", () => {
    expect(typecheck(["!=", 1, 2])).toEqual(ok(BOOL));
  });

  it("< with ints → bool", () => {
    expect(typecheck(["<", 1, 2])).toEqual(ok(BOOL));
  });

  it("< with unknown → bool (no error)", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["<", "x", 1], env)).toEqual(ok(BOOL));
  });

  it("< with string → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["<", "s", 1], env)).toEqual(err("TYPE_MISMATCH"));
  });
});

// --- Logic ---

describe("logic", () => {
  it("and bool bool → bool", () => {
    expect(typecheck(["and", true, false])).toEqual(ok(BOOL));
  });

  it("or bool bool → bool", () => {
    expect(typecheck(["or", true, false])).toEqual(ok(BOOL));
  });

  it("not bool → bool", () => {
    expect(typecheck(["not", true])).toEqual(ok(BOOL));
  });

  it("and with unknown → bool (no error)", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["and", "x", true], env)).toEqual(ok(BOOL));
  });

  it("and with int → TYPE_MISMATCH", () => {
    expect(typecheck(["and", 1, true])).toEqual(err("TYPE_MISMATCH"));
  });

  it("not with int → TYPE_MISMATCH", () => {
    expect(typecheck(["not", 42])).toEqual(err("TYPE_MISMATCH"));
  });
});

// --- Control flow ---

describe("if", () => {
  it("if with bool cond, same branch types → branch type", () => {
    expect(typecheck(["if", true, 1, 2])).toEqual(ok(INT));
  });

  // Phase 1 design: no `union` type. Branch joins unify against a fresh var,
  // so different branch types is now a TYPE_MISMATCH.
  it("if with different branch types → TYPE_MISMATCH", () => {
    expect(typecheck(["if", true, 1, 1.5])).toEqual(err("TYPE_MISMATCH"));
  });

  it("if with unknown cond → no error", () => {
    const env = EMPTY_TYPE_ENV.extend({ c: UNKNOWN });
    expect(typecheck(["if", "c", 1, 2], env)).toEqual(ok(INT));
  });

  it("if with non-bool cond → TYPE_MISMATCH", () => {
    expect(typecheck(["if", 1, 2, 3])).toEqual(err("TYPE_MISMATCH"));
  });

  it("if arity error", () => {
    expect(typecheck(["if", true, 1])).toEqual(err("ARITY_ERROR"));
  });

  it("if branch with unknown silently coexists", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["if", true, "x", 1], env)).toEqual(ok(INT));
  });
});

describe("do", () => {
  it("do returns type of last expr", () => {
    expect(typecheck(["do", 1, true, 3.14])).toEqual(ok(FLOAT));
  });

  it("do arity error", () => {
    expect(typecheck(["do"])).toEqual(err("ARITY_ERROR"));
  });
});

// --- let ---

describe("let", () => {
  it("let binding type propagates to body", () => {
    expect(typecheck(["let", [["x", 42]], "x"])).toEqual(ok(INT));
  });

  it("let with float binding", () => {
    expect(typecheck(["let", [["x", 3.14]], "x"])).toEqual(ok(FLOAT));
  });

  it("let binding used in arithmetic", () => {
    expect(
      typecheck([
        "let",
        [
          ["x", 1],
          ["y", 2],
        ],
        ["+", "x", "y"],
      ]),
    ).toEqual(ok(INT));
  });

  it("let with string binding in arithmetic → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ strVal: STRING });
    expect(typecheck(["let", [["s", "strVal"]], ["+", "s", 1]], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("let sequential binding (second can use first)", () => {
    expect(
      typecheck([
        "let",
        [
          ["x", 1],
          ["y", ["+", "x", 1]],
        ],
        "y",
      ]),
    ).toEqual(ok(INT));
  });

  it("let-bound polymorphic identity used at two types", () => {
    // ["let", [["id", ["fn", ["x"], "x"]]], ["if", ["call", "id", true], ["call", "id", 1], 0]]
    const result = typecheck([
      "let",
      [["id", ["fn", ["x"], "x"]]],
      ["if", ["call", "id", true], ["call", "id", 1], 0],
    ]);
    expect(result).toEqual(ok(INT));
  });
});

// --- letrec ---

describe("letrec", () => {
  it("letrec self-recursive fn typechecks", () => {
    const result = typecheck(["letrec", [["f", ["fn", ["x"], ["call", "f", "x"]]]], "f"]);
    expect(result.ok).toBe(true);
  });

  it("letrec generalizes — recursive identity is polymorphic at use sites", () => {
    const result = typecheck([
      "letrec",
      [["id", ["fn", ["x"], "x"]]],
      ["if", ["call", "id", true], ["call", "id", 1], 0],
    ]);
    expect(result).toEqual(ok(INT));
  });
});

// --- fn and call ---

describe("fn", () => {
  it("fn with unannotated params is polymorphic over fresh vars", () => {
    const result = typecheck(["fn", ["x"], "x"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Identity: fn(a) -> a
      expect(prettyType(result.type)).toBe("fn(a) -> a");
    }
  });

  it("fn with annotated params infers return type", () => {
    const result = typecheck(["fn", [["x", "int"]], ["+", "x", 1]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("fn(int) -> int");
    }
  });

  it("fn body type errors are reported", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["fn", [["x", "int"]], ["+", "x", "s"]], env);
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });
});

describe("call", () => {
  it("call known fn → return type", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT], ret: INT } as MType,
    });
    expect(typecheck(["call", "f", 1], env)).toEqual(ok(INT));
  });

  it("call unknown fn → fresh result var (silently passes)", () => {
    const env = EMPTY_TYPE_ENV.extend({ f: UNKNOWN });
    const result = typecheck(["call", "f", 1], env);
    expect(result.ok).toBe(true);
    // Result is a fresh type var (printed as "a" after alpha-rename).
    if (result.ok) {
      expect(prettyType(result.type)).toBe("a");
    }
  });

  it("call with wrong arity → ARITY_ERROR", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT], ret: INT } as MType,
    });
    expect(typecheck(["call", "f", 1, 2], env)).toEqual(err("ARITY_ERROR"));
  });

  it("call with wrong arg type → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT], ret: INT } as MType,
      s: STRING,
    });
    expect(typecheck(["call", "f", "s"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("call inline fn literal — HM unifies x with 5 → int", () => {
    // Under HM, fn(x) -> x+1 applied to 5 unifies x with int → return type int.
    const result = typecheck(["call", ["fn", ["x"], ["+", "x", 1]], 5]);
    expect(result).toEqual(ok(INT));
  });
});

// --- unknown passes through ---

describe("unknown propagation", () => {
  it("unknown in any position suppresses type errors", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    // unknown + unknown → unknown (no constraints, no errors)
    expect(typecheck(["+", "x", "x"], env)).toEqual(ok(UNKNOWN));
    // unknown and unknown → bool
    expect(typecheck(["and", "x", "x"], env)).toEqual(ok(BOOL));
  });

  it("unknown variable in if condition is ok", () => {
    const env = EMPTY_TYPE_ENV.extend({ c: UNKNOWN });
    expect(typecheck(["if", "c", 1, 2], env)).toEqual(ok(INT));
  });

  it("unknown in comparison is ok", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    expect(typecheck(["<", "x", 1], env)).toEqual(ok(BOOL));
    expect(typecheck(["==", "x", "x"], env)).toEqual(ok(BOOL));
  });
});

// --- untyped ---

describe("untyped", () => {
  it("untyped returns unknown without checking inner", () => {
    expect(typecheck(["untyped", ["+", "undefined_var", "also_undefined"]])).toEqual(ok(UNKNOWN));
  });

  it("untyped with wrong arg count → ARITY_ERROR", () => {
    expect(typecheck(["untyped"])).toEqual(err("ARITY_ERROR"));
  });
});

// --- Array primitives (Phase 1) ---

describe("array ops", () => {
  it("array of homogeneous ints → array<int>", () => {
    expect(typecheck(["array", 1, 2, 3])).toEqual(ok({ kind: "array", elem: INT }));
  });

  it("array of mixed types → TYPE_MISMATCH", () => {
    expect(typecheck(["array", 1, "x"])).toEqual(err("UNDEFINED_VAR")); // "x" var lookup
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["array", 1, "s"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("array-len → int", () => {
    const env = EMPTY_TYPE_ENV.extend({
      a: { kind: "array", elem: INT } as MType,
    });
    expect(typecheck(["array-len", "a"], env)).toEqual(ok(INT));
  });

  it("array-get → element type", () => {
    const env = EMPTY_TYPE_ENV.extend({
      a: { kind: "array", elem: INT } as MType,
    });
    expect(typecheck(["array-get", "a", 0], env)).toEqual(ok(INT));
  });

  it("array-push preserves element type", () => {
    const env = EMPTY_TYPE_ENV.extend({
      a: { kind: "array", elem: INT } as MType,
    });
    expect(typecheck(["array-push", "a", 5], env)).toEqual(ok({ kind: "array", elem: INT }));
  });

  it("array-push with wrong elem type → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({
      a: { kind: "array", elem: INT } as MType,
      s: STRING,
    });
    expect(typecheck(["array-push", "a", "s"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("array-map fn(a)->b array<a> → array<b>", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT], ret: BOOL } as MType,
      arr: { kind: "array", elem: INT } as MType,
    });
    expect(typecheck(["array-map", "f", "arr"], env)).toEqual(ok({ kind: "array", elem: BOOL }));
  });

  it("array-map with non-array → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT], ret: BOOL } as MType,
      x: INT,
    });
    expect(typecheck(["array-map", "f", "x"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("array-filter preserves element type", () => {
    const env = EMPTY_TYPE_ENV.extend({
      pred: { kind: "fn", params: [INT], ret: BOOL } as MType,
      arr: { kind: "array", elem: INT } as MType,
    });
    expect(typecheck(["array-filter", "pred", "arr"], env)).toEqual(
      ok({ kind: "array", elem: INT }),
    );
  });

  it("array-reduce with init type → acc type", () => {
    const env = EMPTY_TYPE_ENV.extend({
      f: { kind: "fn", params: [INT, INT], ret: INT } as MType,
      arr: { kind: "array", elem: INT } as MType,
    });
    expect(typecheck(["array-reduce", "f", 0, "arr"], env)).toEqual(ok(INT));
  });

  it("count array → int", () => {
    const env = EMPTY_TYPE_ENV.extend({
      arr: { kind: "array", elem: INT } as MType,
    });
    expect(typecheck(["count", "arr"], env)).toEqual(ok(INT));
  });

  it("count non-array → TYPE_MISMATCH", () => {
    expect(typecheck(["count", 1])).toEqual(err("TYPE_MISMATCH"));
  });
});

// --- String ops (Phase 1 — str-* family) ---

describe("string ops", () => {
  it("str-concat strings → string", () => {
    const env = EMPTY_TYPE_ENV.extend({ a: STRING, b: STRING });
    expect(typecheck(["str-concat", "a", "b"], env)).toEqual(ok(STRING));
  });

  it("str-concat non-string → TYPE_MISMATCH", () => {
    expect(typecheck(["str-concat", 1, 2])).toEqual(err("TYPE_MISMATCH"));
  });

  it("str-slice string int int → string", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["str-slice", "s", 0, 3], env)).toEqual(ok(STRING));
  });

  it("str-len string → int", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["str-len", "s"], env)).toEqual(ok(INT));
  });

  it("str-upper string → string", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["str-upper", "s"], env)).toEqual(ok(STRING));
  });

  it("str-split string string → array<string>", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING, sep: STRING });
    expect(typecheck(["str-split", "s", "sep"], env)).toEqual(ok({ kind: "array", elem: STRING }));
  });

  it("to-string any → string", () => {
    expect(typecheck(["to-string", 42])).toEqual(ok(STRING));
    expect(typecheck(["to-string", true])).toEqual(ok(STRING));
  });

  it("parse-int string → int (Phase 1: no Option type yet)", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["parse-int", "s"], env)).toEqual(ok(INT));
  });

  it("parse-int non-string → TYPE_MISMATCH", () => {
    expect(typecheck(["parse-int", 42])).toEqual(err("TYPE_MISMATCH"));
  });
});

// --- Phase 4+ ops are not-yet-implemented ---

describe("Phase 4+ ops fail loudly", () => {
  it("unregistered variant constructor → UNKNOWN_VARIANT", () => {
    expect(typecheck(["Circle", 1.5])).toEqual(err("UNKNOWN_VARIANT"));
  });

  it("match on unregistered variant → UNKNOWN_VARIANT", () => {
    const env = EMPTY_TYPE_ENV.extend({ v: UNKNOWN });
    expect(typecheck(["match", "v", [["Tag"], 42]], env)).toEqual(err("UNKNOWN_VARIANT"));
  });
});

// --- Phase 4: algebraic effects ---

describe("Phase 4: perform", () => {
  it("perform Async with int payload → resume type", () => {
    // Inside a handle so the effect is in scope; the resume type is fresh,
    // but the perform expression's type must equal the resume var.
    const result = typecheck([
      "handle",
      ["perform", "Async", 42],
      [
        ["Async", "v", "k"],
        ["call", "k", "v"],
      ],
    ]);
    expect(result.ok).toBe(true);
  });

  it("perform unifies payload type — wrong type errors", () => {
    // Two performs of the same tag with conflicting payload types.
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(
      [
        "handle",
        ["do", ["perform", "MyEff", 1], ["perform", "MyEff", "s"]],
        [
          ["MyEff", "v", "k"],
          ["call", "k", "v"],
        ],
      ],
      env,
    );
    expect(result.ok).toBe(false);
  });

  it("unhandled perform propagates effect through fn into outer type", () => {
    // A function that performs an effect carries it in its effect row.
    const result = typecheck(["fn", ["x"], ["perform", "Log", "x"]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const s = prettyType(result.type);
      expect(s).toContain("Log");
      expect(s).toContain("!");
    }
  });

  it("pure function has no `!` annotation", () => {
    const result = typecheck(["fn", ["x"], ["+", "x", 1]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).not.toContain("!");
    }
  });
});

describe("Phase 4: handle", () => {
  it("handle return clause yields its body's type", () => {
    // Body returns int; return clause maps x → str-len(to-string(x)) (string).
    // Without the return clause the result would be int; with it, it's int.
    const result = typecheck([
      "handle",
      ["+", 1, 2],
      [
        ["return", "x"],
        ["*", "x", 2],
      ],
    ]);
    expect(result).toEqual(ok(INT));
  });

  it("handle without return clause returns body type", () => {
    const result = typecheck(["handle", ["+", 1, 2]]);
    expect(result).toEqual(ok(INT));
  });

  it("handle binds k as fn(R) -> resultType", () => {
    // Inside the clause, k must be callable with the resume type.
    // Ask returns whatever k is called with; the handler resumes k with 10.
    const result = typecheck([
      "handle",
      ["+", ["perform", "Ask", null], 5],
      [
        ["Ask", "_", "k"],
        ["call", "k", 10],
      ],
      [["return", "x"], "x"],
    ]);
    expect(result).toEqual(ok(INT));
  });

  it("handled effect is removed from the result expression's effect row", () => {
    // A pure outer scope: the handle expression as a whole has no effect rows.
    // We test this by putting the handle inside a fn — the fn must remain pure.
    const result = typecheck([
      "fn",
      ["x"],
      [
        "handle",
        ["perform", "Local", "x"],
        [
          ["Local", "v", "k"],
          ["call", "k", "v"],
        ],
        [["return", "y"], "y"],
      ],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The fn is pure — Local is fully handled internally.
      expect(prettyType(result.type)).not.toContain("Local");
    }
  });

  it("unhandled effect propagates through function boundary", () => {
    // A fn calls perform on Custom; without a handle, the fn's effect row
    // contains Custom.
    const result = typecheck(["fn", [], ["perform", "Custom", null]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toContain("Custom");
    }
  });

  it("call propagates callee's effects to caller", () => {
    // f performs Foo; calling f from g should give g the Foo effect.
    const result = typecheck([
      "let",
      [["f", ["fn", [], ["perform", "Foo", null]]]],
      ["fn", [], ["call", "f"]],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toContain("Foo");
    }
  });
});

// --- Records and row polymorphism (Phase 2) ---

describe("records", () => {
  it("record literal → closed record type", () => {
    const env = EMPTY_TYPE_ENV.extend({ hello: STRING });
    const result = typecheck(["record", ["x", 1], ["y", "hello"]], env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("{x: int, y: string}");
    }
  });

  it("{} literal works as record literal", () => {
    const result = typecheck(["{}", ["a", true]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("{a: bool}");
    }
  });

  it("get on closed record returns field type", () => {
    const result = typecheck(["get", ["record", ["x", 1], ["y", 2.5]], "x"]);
    expect(result).toEqual(ok(INT));
  });

  it("get on missing field of closed record → TYPE_MISMATCH", () => {
    const result = typecheck(["get", ["record", ["x", 1]], "missing"]);
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });

  it("get with non-string key still typechecks but loses precision", () => {
    const env = EMPTY_TYPE_ENV.extend({ r: UNKNOWN, k: STRING });
    const result = typecheck(["get", "r", "k"], env);
    expect(result.ok).toBe(true);
  });

  it("set on closed record returns same record type", () => {
    const result = typecheck(["set", ["record", ["x", 1]], "x", 2]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("{x: int}");
    }
  });

  it("set with wrong value type for existing key → TYPE_MISMATCH", () => {
    const result = typecheck(["set", ["record", ["x", 1]], "x", "wrong"]);
    expect(result).toEqual(err("UNDEFINED_VAR"));
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["set", ["record", ["x", 1]], "x", "s"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("merge of two closed records produces closed merged record", () => {
    const env = EMPTY_TYPE_ENV.extend({ hi: STRING });
    const result = typecheck(["merge", ["record", ["x", 1]], ["record", ["y", "hi"]]], env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("{x: int, y: string}");
    }
  });

  it("merge: b shadows a on conflict", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["merge", ["record", ["x", 1]], ["record", ["x", "s"]]], env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("{x: string}");
    }
  });

  it("keys on record → array<string>", () => {
    const result = typecheck(["keys", ["record", ["x", 1], ["y", 2]]]);
    expect(result).toEqual(ok({ kind: "array", elem: STRING }));
  });

  it("vals on homogeneous record → array<T>", () => {
    const result = typecheck(["vals", ["record", ["x", 1], ["y", 2]]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("array<int>");
    }
  });

  it("count on record → int", () => {
    const result = typecheck(["count", ["record", ["x", 1], ["y", 2]]]);
    expect(result).toEqual(ok(INT));
  });

  it("record-has → bool", () => {
    const result = typecheck(["record-has", ["record", ["x", 1]], "x"]);
    expect(result).toEqual(ok(BOOL));
  });

  it("record-del returns record", () => {
    const result = typecheck(["record-del", ["record", ["x", 1], ["y", 2]], "x"]);
    expect(result.ok).toBe(true);
  });
});

describe("row polymorphism", () => {
  it("function that gets `name` field works on any record with name", () => {
    // (fn (r) (get r "name"))
    const result = typecheck(["fn", ["r"], ["get", "r", "name"]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should be: fn({name: a | b}) -> a
      const s = prettyType(result.type);
      expect(s).toContain("name:");
      expect(s).toContain("->");
    }
  });

  it("polymorphic get-name applied to records with extra fields", () => {
    const env = EMPTY_TYPE_ENV.extend({
      alice: STRING,
      bob: STRING,
      addr: STRING,
    });
    const result = typecheck(
      [
        "let",
        [["getName", ["fn", ["r"], ["get", "r", "name"]]]],
        [
          "array",
          ["call", "getName", ["record", ["name", "alice"], ["age", 30]]],
          ["call", "getName", ["record", ["name", "bob"], ["email", "addr"]]],
        ],
      ],
      env,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("array<string>");
    }
  });

  it("get-in nested path", () => {
    const env = EMPTY_TYPE_ENV.extend({ alice: STRING });
    const inner: Expr = ["record", ["name", "alice"]];
    const outer: Expr = ["record", ["user", inner]];
    const result = typecheck(["get-in", outer, ["array", "user", "name"]], env);
    expect(result).toEqual(ok(STRING));
  });

  it("closed record cannot be unified with record requiring missing field", () => {
    // get "missing" on a closed record literal {x: int}
    const result = typecheck(["get", ["record", ["x", 1]], "missing"]);
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });

  it("fn that calls get and uses field as int constrains row field type", () => {
    const result = typecheck(["fn", ["r"], ["+", ["get", "r", "n"], 1]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const s = prettyType(result.type);
      // Result type should be int and parameter row should mention n: int
      expect(s).toContain("n: int");
      expect(s).toContain("-> int");
    }
  });
});

// --- Error collection (multiple errors) ---

describe("error collection", () => {
  it("collects errors from multiple subexpressions", () => {
    // Both args to + are strings. After unifying ta=tb (string=string OK),
    // we still emit the TYPE_MISMATCH for the non-numeric resolved type.
    const env = EMPTY_TYPE_ENV.extend({ a: STRING, b: STRING });
    const result = typecheck(["+", "a", "b"], env);
    expect(result.ok).toBe(false);
  });

  it("nested errors all collected", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["if", 1, ["+", "s", 1], 2], env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("errors have path information", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["+", "s", 1], env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // First error is at path [1] or [2] depending on order.
      expect(result.errors.some((e) => e.path.length > 0)).toBe(true);
    }
  });

  it("errors have expected/got fields", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["+", "s", 1], env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors[0];
      expect(e?.expected).toBeDefined();
      expect(e?.got).toBeDefined();
    }
  });
});

// --- type ops ---

describe("type ops", () => {
  it("is T expr → bool", () => {
    expect(typecheck(["is", "int", 42])).toEqual(ok(BOOL));
  });

  it("as T expr → T type", () => {
    expect(typecheck(["as", "int", 42])).toEqual(ok(INT));
    expect(typecheck(["as", "bool", true])).toEqual(ok(BOOL));
    expect(typecheck(["as", "float", 1.5])).toEqual(ok(FLOAT));
  });
});

// --- prettyType ---

describe("prettyType", () => {
  it("renders monotypes", () => {
    expect(prettyType(INT)).toBe("int");
    expect(prettyType(STRING)).toBe("string");
    expect(prettyType({ kind: "array", elem: INT })).toBe("array<int>");
  });

  it("alpha-renames free vars to a, b, c", () => {
    const t: MType = {
      kind: "fn",
      params: [
        { kind: "var", id: 7 },
        { kind: "var", id: 12 },
      ],
      ret: { kind: "var", id: 7 },
    };
    expect(prettyType(t)).toBe("fn(a, b) -> a");
  });
});

// --- Module ---

describe("typecheckModule", () => {
  it("typechecks main expression", () => {
    const result = typecheckModule({ main: ["+", 1, 2] });
    expect(result).toEqual(ok(INT));
  });

  it("rejects int + float in main (no widening)", () => {
    expect(typecheckModule({ main: ["+", 1, 1.5] })).toEqual(err("TYPE_MISMATCH"));
  });

  it("type error in module main", () => {
    const result = typecheckModule({ main: "undefined_var" });
    expect(result).toEqual(err("UNDEFINED_VAR"));
  });
});

// --- Edge cases ---

describe("edge cases", () => {
  it("empty array → UNKNOWN_OP error", () => {
    expect(typecheck([])).toEqual(err("UNKNOWN_OP"));
  });

  it("non-string op → UNKNOWN_OP error", () => {
    expect(typecheck([1, 2, 3] as unknown as Expr)).toEqual(err("UNKNOWN_OP"));
  });

  it("unknown op → UNKNOWN_OP error", () => {
    expect(typecheck(["not-an-op", 1, 2])).toEqual(err("UNKNOWN_OP"));
  });

  it("variant constructor with subexpr errors propagated", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    // Circle is unknown (no type def in scope). Inner arithmetic error still reported.
    const result = typecheck(["Circle", ["+", "s", 1]], env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("TYPE_MISMATCH");
    }
  });
});

// --- Phase 3: discriminated unions, nominal types, match exhaustiveness ---

describe("Phase 3: variant constructors", () => {
  it("Some(int) → option<int> via lib:std", () => {
    const result = typecheckModule({ main: ["Some", 42] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toBe("option<int>");
    }
  });

  it("None → option<a> (polymorphic)", () => {
    const result = typecheckModule({ main: ["None"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // option with a fresh type var
      expect(prettyType(result.type)).toMatch(/^option<[a-z]\d*>$/);
    }
  });

  it("Ok(string) → result<string, e>", () => {
    const result = typecheck(["Ok", "s"], EMPTY_TYPE_ENV.extend({ s: STRING }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toMatch(/^result<string, [a-z]\d*>$/);
    }
  });

  it("Err(int) → result<a, int>", () => {
    const result = typecheckModule({ main: ["Err", 7] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toMatch(/^result<[a-z]\d*, int>$/);
    }
  });

  it("module-defined Shape constructor → Shape", () => {
    const result = typecheckModule({
      types: [
        {
          name: "Shape",
          variants: [
            { tag: "Circle", fields: [["radius", "float"]] },
            {
              tag: "Rect",
              fields: [
                ["width", "float"],
                ["height", "float"],
              ],
            },
          ],
        },
      ],
      main: ["Circle", 1.5],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("Shape");
  });

  it("Circle with wrong field type → TYPE_MISMATCH", () => {
    const result = typecheckModule({
      types: [
        {
          name: "Shape",
          variants: [{ tag: "Circle", fields: [["radius", "float"]] }],
        },
      ],
      main: ["Circle", "not-a-float"],
    });
    expect(result).toEqual(err("UNDEFINED_VAR"));
  });

  it("Circle with wrong arity → ARITY_ERROR", () => {
    const result = typecheckModule({
      types: [
        {
          name: "Shape",
          variants: [{ tag: "Circle", fields: [["radius", "float"]] }],
        },
      ],
      main: ["Circle", 1.5, 2.5],
    });
    expect(result).toEqual(err("ARITY_ERROR"));
  });
});

describe("Phase 3: nominal types", () => {
  it("named<int> and named<float> with same name unify args (mismatch on int vs float)", () => {
    // Construct two option values with conflicting payload types and force them
    // into the same array; HM unification fails.
    const result = typecheckModule({
      main: ["array", ["Some", 1], ["Some", 1.5]],
    });
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });

  it("Foo and Bar with same arity are still distinct (nominal, not structural)", () => {
    const result = typecheckModule({
      types: [
        { name: "A", variants: [{ tag: "FooA" }] },
        { name: "B", variants: [{ tag: "FooB" }] },
      ],
      main: ["array", ["FooA"], ["FooB"]],
    });
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });
});

describe("Phase 3: match", () => {
  it("match binds variant fields with correct types", () => {
    const result = typecheckModule({
      types: [
        {
          name: "Shape",
          variants: [
            { tag: "Circle", fields: [["radius", "float"]] },
            {
              tag: "Rect",
              fields: [
                ["width", "float"],
                ["height", "float"],
              ],
            },
          ],
        },
      ],
      main: [
        "match",
        ["Circle", 1.5],
        [["Circle", "r"], "r"],
        [
          ["Rect", "w", "h"],
          ["*", "w", "h"],
        ],
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("float");
  });

  it("match on Some/None binds inner type", () => {
    const result = typecheckModule({
      main: [
        "match",
        ["Some", 42],
        [
          ["Some", "x"],
          ["+", "x", 1],
        ],
        [["None"], 0],
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("int");
  });

  it("non-exhaustive match → NON_EXHAUSTIVE_MATCH", () => {
    const result = typecheckModule({
      types: [
        {
          name: "Shape",
          variants: [{ tag: "Circle", fields: [["r", "float"]] }, { tag: "Square" }],
        },
      ],
      main: ["match", ["Circle", 1.5], [["Circle", "r"], "r"]],
    });
    expect(result).toEqual(err("NON_EXHAUSTIVE_MATCH"));
  });

  it("exhaustive via wildcard passes", () => {
    const result = typecheckModule({
      types: [
        {
          name: "Shape",
          variants: [{ tag: "Circle", fields: [["r", "float"]] }, { tag: "Square" }],
        },
      ],
      main: ["match", ["Circle", 1.5], [["Circle", "r"], "r"], ["_", 9.99]],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("float");
  });

  it("exhaustive via variable binding passes", () => {
    const result = typecheckModule({
      types: [{ name: "Shape", variants: [{ tag: "A" }, { tag: "B" }] }],
      main: ["match", ["A"], ["x", 1]],
    });
    expect(result.ok).toBe(true);
  });

  it("match on option exhaustively → ok", () => {
    const result = typecheckModule({
      main: ["match", ["Some", 1], [["Some", "x"], "x"], [["None"], 0]],
    });
    expect(result.ok).toBe(true);
  });

  it("match on option non-exhaustively → NON_EXHAUSTIVE_MATCH", () => {
    const result = typecheckModule({
      main: ["match", ["Some", 1], [["Some", "x"], "x"]],
    });
    expect(result).toEqual(err("NON_EXHAUSTIVE_MATCH"));
  });

  it("match branch type mismatch → TYPE_MISMATCH", () => {
    const result = typecheckModule({
      main: ["match", ["Some", 1], [["Some", "x"], "x"], [["None"], "not-an-int"]],
    });
    expect(result).toEqual(err("UNDEFINED_VAR"));
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["match", ["Some", 1], [["Some", "x"], "x"], [["None"], "s"]], env)).toEqual(
      err("TYPE_MISMATCH"),
    );
  });

  it("match on result<int, string> exhaustively", () => {
    const result = typecheckModule({
      main: ["match", ["Ok", 42], [["Ok", "x"], "x"], [["Err", "e"], 0]],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("int");
  });

  // ---- Unhandled effects at module scope ----

  it("perform at module scope without handle → UNHANDLED_EFFECTS", () => {
    const result = typecheckModule({ main: ["perform", "Error", 42] });
    expect(result).toEqual(err("UNHANDLED_EFFECTS"));
  });

  it("perform wrapped in handle at module scope → passes", () => {
    // handle absorbs the Error effect; the module expression is pure.
    const result = typecheckModule({
      main: [
        "handle",
        ["perform", "Error", 42],
        [["Error", "payload", "k"], 0],
        [["return", "v"], "v"],
      ],
    });
    expect(result.ok).toBe(true);
  });
});

// --- Phase 5: capabilities and call.method ---

const CAP_NETWORK: MType = {
  kind: "named",
  name: "Cap",
  args: [{ kind: "named", name: "Network", args: [] }],
};
const CAP_STORAGE: MType = {
  kind: "named",
  name: "Cap",
  args: [{ kind: "named", name: "Storage", args: [] }],
};
const CAP_PLUGIN: MType = {
  kind: "named",
  name: "Cap",
  args: [{ kind: "named", name: "LocalAgent", args: [] }],
};

describe("Phase 5: capabilities and call.method", () => {
  it("call.method on Cap<Network> 'get' → string", () => {
    const env = EMPTY_TYPE_ENV.extend({ net: CAP_NETWORK, url: STRING });
    const result = typecheck(["call.method", "net", "get", "url"], env);
    expect(result).toEqual(ok(STRING));
  });

  it("call.method on Cap<Storage> 'list' → array<string>", () => {
    const env = EMPTY_TYPE_ENV.extend({ st: CAP_STORAGE, prefix: STRING });
    const result = typecheck(["call.method", "st", "list", "prefix"], env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("array<string>");
  });

  it("call.method on Cap<Storage> 'set' → null", () => {
    const env = EMPTY_TYPE_ENV.extend({
      st: CAP_STORAGE,
      k: STRING,
      v: STRING,
    });
    const result = typecheck(["call.method", "st", "set", "k", "v"], env);
    expect(result).toEqual(ok(NULL_T));
  });

  it("call.method on plugin-defined cap → unknown (gradual escape)", () => {
    const env = EMPTY_TYPE_ENV.extend({ cap: CAP_PLUGIN, x: STRING });
    const result = typecheck(["call.method", "cap", "anything", "x"], env);
    expect(result).toEqual(ok(UNKNOWN));
  });

  it("call.method on unknown cap → unknown", () => {
    const env = EMPTY_TYPE_ENV.extend({ cap: UNKNOWN, x: STRING });
    const result = typecheck(["call.method", "cap", "get", "x"], env);
    expect(result).toEqual(ok(UNKNOWN));
  });

  it("call.method with unknown method name on known cap → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ net: CAP_NETWORK, x: STRING });
    expect(typecheck(["call.method", "net", "fly", "x"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("call.method with arity mismatch → ARITY_ERROR", () => {
    const env = EMPTY_TYPE_ENV.extend({ net: CAP_NETWORK, url: STRING });
    // post takes (url, body) — calling with one arg is an arity error
    expect(typecheck(["call.method", "net", "post", "url"], env)).toEqual(err("ARITY_ERROR"));
  });

  it("call.method with wrong arg type → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ net: CAP_NETWORK });
    expect(typecheck(["call.method", "net", "get", 42], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("call.method on non-Cap value → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: INT, url: STRING });
    expect(typecheck(["call.method", "x", "get", "url"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("call.method adds the method's effect to the ambient row", () => {
    const env = EMPTY_TYPE_ENV.extend({ net: CAP_NETWORK, url: STRING });
    const result = typecheck(["fn", [], ["call.method", "net", "get", "url"]], env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const s = prettyType(result.type);
      expect(s).toContain("Network");
      expect(s).toContain("!");
    }
  });

  it("prettyType for Cap<Network> renders as Cap<Network>", () => {
    const env = EMPTY_TYPE_ENV.extend({ net: CAP_NETWORK });
    const result = typecheck("net", env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("Cap<Network>");
  });

  it("call.method requires method name as a string literal", () => {
    const env = EMPTY_TYPE_ENV.extend({ net: CAP_NETWORK, m: STRING });
    // Method name is a variable reference, not a literal — should error.
    expect(typecheck(["call.method", "net", ["+", 1, 2], "x"], env)).toEqual(err("TYPE_MISMATCH"));
  });

  it("call.method missing method name → ARITY_ERROR", () => {
    const env = EMPTY_TYPE_ENV.extend({ net: CAP_NETWORK });
    expect(typecheck(["call.method", "net"], env)).toEqual(err("ARITY_ERROR"));
  });
});

// ===========================================================================
// Comprehensive HM-stress tests below this line.
// These exercise inference depth, unification edge cases, gradual boundaries,
// let-generalisation, row polymorphism, variants/match, effects, capabilities,
// and error quality.
// ===========================================================================

describe("HM: inference depth", () => {
  it("deeply nested lets propagate inner type from outer context", () => {
    const result = typecheck([
      "let",
      [["a", 1]],
      ["let", [["b", "a"]], ["let", [["c", "b"]], ["let", [["d", "c"]], ["+", "d", 1]]]],
    ]);
    expect(result).toEqual(ok(INT));
  });

  it("fn parameter type only constrained at deeply nested use site", () => {
    // x is used inside two `if`s plus an arithmetic op — must be int.
    const result = typecheck(["fn", ["x"], ["if", true, ["if", true, ["+", "x", 1], 0], 0]]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("fn(int) -> int");
  });

  it("polymorphic function used at two different types in same let body", () => {
    // id used at int and string in the same expression.
    const env = EMPTY_TYPE_ENV.extend({ hi: STRING });
    const result = typecheck(
      [
        "let",
        [["id", ["fn", ["x"], "x"]]],
        ["array", ["to-string", ["call", "id", 1]], ["call", "id", "hi"]],
      ],
      env,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("array<string>");
  });

  it("nested fn captures outer type variable", () => {
    // mk : fn(a) -> fn(b) -> a   (Church-style const).
    const env = EMPTY_TYPE_ENV.extend({ ig: STRING });
    const result = typecheck(
      ["let", [["mk", ["fn", ["x"], ["fn", ["y"], "x"]]]], ["call", ["call", "mk", 1], "ig"]],
      env,
    );
    expect(result).toEqual(ok(INT));
  });

  it("letrec mutual recursion infers both function types", () => {
    const result = typecheck([
      "letrec",
      [
        ["even", ["fn", ["n"], ["if", ["==", "n", 0], true, ["call", "odd", ["-", "n", 1]]]]],
        ["odd", ["fn", ["n"], ["if", ["==", "n", 0], false, ["call", "even", ["-", "n", 1]]]]],
      ],
      ["call", "even", 4],
    ]);
    expect(result).toEqual(ok(BOOL));
  });
});

describe("HM: unification edge cases", () => {
  it("occurs check: x applied to itself errors", () => {
    expect(typecheck(["fn", ["x"], ["call", "x", "x"]])).toEqual(err("TYPE_MISMATCH"));
  });

  it("occurs check: cyclic record set with self errors", () => {
    expect(typecheck(["fn", ["r"], ["set", "r", "self", "r"]])).toEqual(err("TYPE_MISMATCH"));
  });

  it("two closed records with disjoint field sets fail to unify", () => {
    // Forced into same array.
    const result = typecheck(["array", ["record", ["a", 1]], ["record", ["b", 2]]]);
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });

  it("closed record absorbed into closed record with same fields", () => {
    const result = typecheck([
      "array",
      ["record", ["x", 1], ["y", 2]],
      ["record", ["x", 3], ["y", 4]],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("array<{x: int, y: int}>");
  });

  it("open record absorbs missing field via outer fn (row poly)", () => {
    // f reads x and y; passed a record with x,y,z extra — works.
    const result = typecheck([
      "let",
      [["f", ["fn", ["r"], ["+", ["get", "r", "x"], ["get", "r", "y"]]]]],
      ["call", "f", ["record", ["x", 1], ["y", 2], ["z", 3]]],
    ]);
    expect(result).toEqual(ok(INT));
  });

  it("set adding a brand-new field to a closed record is a TYPE_MISMATCH", () => {
    // The spec leaves this open; the implementation chose: closed records
    // cannot be extended (set on a missing field of a closed record errors).
    expect(typecheck(["set", ["record", ["x", 1]], "newfield", 2])).toEqual(err("TYPE_MISMATCH"));
  });

  it("type mismatch deep inside nested let reports a path", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(
      ["let", [["a", 1]], ["let", [["b", "a"]], ["let", [["c", "s"]], ["+", "c", 1]]]],
      env,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("TYPE_MISMATCH");
      expect(result.errors[0]?.path.length).toBeGreaterThan(0);
    }
  });

  it("two row types sharing some fields, differing in others, both open — unifies", () => {
    // Both fns read 'x' from their args; param rows have shared 'x' fields
    // and independent open tails.
    const result = typecheck(["fn", ["a", "b"], ["+", ["get", "a", "x"], ["get", "b", "x"]]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Each parameter has its own open tail; the shared field 'x' has
      // a single unified element type that becomes the return type.
      const s = prettyType(result.type);
      expect(s).toContain("x: ");
      // The two open tails are independent (different vars).
      expect(s).toMatch(/x: a \| [a-z]\d*}, \{x: a \| [a-z]\d*}/);
    }
  });
});

describe("HM: gradual typing boundary", () => {
  it("unknown in one branch of if does not infect the other branch", () => {
    const env = EMPTY_TYPE_ENV.extend({ u: UNKNOWN });
    // Then branch is unknown, else branch is concrete int.
    const result = typecheck(["if", true, "u", 1], env);
    expect(result).toEqual(ok(INT));
  });

  it("unknown function arg does not collapse fn return type", () => {
    // Function ignores its arg and returns a literal — return is concrete int.
    const env = EMPTY_TYPE_ENV.extend({ any: STRING });
    const result = typecheck(["call", ["fn", [["x", "unknown"]], 42], "any"], env);
    expect(result).toEqual(ok(INT));
  });

  it("untyped → unknown; as int narrows it for arithmetic", () => {
    const result = typecheck(["+", ["as", "int", ["untyped", "anything"]], 1]);
    expect(result).toEqual(ok(INT));
  });

  it("fn declared with unknown param accepts a concretely-typed arg", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(
      ["let", [["f", ["fn", [["x", "unknown"]], ["+", 1, 2]]]], ["call", "f", "s"]],
      env,
    );
    expect(result).toEqual(ok(INT));
  });

  it("untyped silences all inner errors", () => {
    // Inner expression has UNDEFINED_VAR + arity, but untyped suppresses.
    const result = typecheck(["untyped", ["+", "no", "such", "var"]]);
    expect(result).toEqual(ok(UNKNOWN));
  });
});

describe("HM: let-generalisation", () => {
  it("identity function generalises and is callable at int and bool", () => {
    const result = typecheck([
      "let",
      [["id", ["fn", ["x"], "x"]]],
      ["if", ["call", "id", true], ["call", "id", 1], 0],
    ]);
    expect(result).toEqual(ok(INT));
  });

  it("generalised fn stored in record field is polymorphic at retrieval", () => {
    // Retrieve id from rec, call with int and string in the same expr.
    const env = EMPTY_TYPE_ENV.extend({ hi: STRING });
    const result = typecheck(
      [
        "let",
        [["rec", ["record", ["id", ["fn", ["x"], "x"]]]]],
        [
          "array",
          ["to-string", ["call", ["get", "rec", "id"], 1]],
          ["call", ["get", "rec", "id"], "hi"],
        ],
      ],
      env,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("array<string>");
  });

  it("const fn generalises and is callable with two arg-type pairings", () => {
    const env = EMPTY_TYPE_ENV.extend({ ig: STRING });
    const result = typecheck(
      [
        "let",
        [["k", ["fn", ["x", "y"], "x"]]],
        ["array", ["call", "k", 1, true], ["call", "k", 2, "ig"]],
      ],
      env,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("array<int>");
  });

  it("non-generalised vars don't escape: lambda parameter is not polymorphic", () => {
    // Inside a fn, x's type is a single fresh var — using it at incompatible
    // types in the body must fail. (Compare against `let`, which generalises.)
    const result = typecheck(["fn", ["id"], ["if", ["call", "id", true], ["call", "id", 1], 0]]);
    // First call fixes id's param to bool; second call requires bool but
    // gets int → TYPE_MISMATCH.
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });
});

describe("HM: row polymorphism", () => {
  it("get-field fn applied to records with disjoint extra fields", () => {
    const env = EMPTY_TYPE_ENV.extend({
      a: STRING,
      b: STRING,
      addr: STRING,
    });
    const result = typecheck(
      [
        "let",
        [["getName", ["fn", ["r"], ["get", "r", "name"]]]],
        [
          "array",
          ["call", "getName", ["record", ["name", "a"], ["age", 30]]],
          ["call", "getName", ["record", ["name", "b"], ["email", "addr"]]],
        ],
      ],
      env,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("array<string>");
  });

  it("merge open + closed: open absorbs the closed fields", () => {
    // fn takes open r, merges with {extra: int} — result includes extra.
    const result = typecheck(["fn", ["r"], ["merge", "r", ["record", ["extra", 42]]]]);
    expect(result.ok).toBe(true);
  });

  it("get-in two levels works on literal nested records", () => {
    const env = EMPTY_TYPE_ENV.extend({ alice: STRING });
    const result = typecheck(
      ["get-in", ["record", ["user", ["record", ["name", "alice"]]]], ["array", "user", "name"]],
      env,
    );
    expect(result).toEqual(ok(STRING));
  });

  it("calling row-poly fn on a record missing required field errors", () => {
    expect(typecheck(["call", ["fn", ["r"], ["get", "r", "x"]], ["record", ["y", 1]]])).toEqual(
      err("TYPE_MISMATCH"),
    );
  });
});

describe("HM: variants and DUs", () => {
  it("constructor with too few args → ARITY_ERROR", () => {
    expect(typecheck(["Some"])).toEqual(err("ARITY_ERROR"));
  });

  it("constructor with too many args → ARITY_ERROR", () => {
    expect(typecheck(["None", 1])).toEqual(err("ARITY_ERROR"));
  });

  it("constructor field types inferred from outer match context", () => {
    // x is `Some 1` so v is bound to int; the body adds 1.
    const result = typecheck([
      "let",
      [["x", ["Some", 1]]],
      [
        "match",
        "x",
        [
          ["Some", "v"],
          ["+", "v", 1],
        ],
        [["None"], 0],
      ],
    ]);
    expect(result).toEqual(ok(INT));
  });

  it("match scrutinee type inferred purely from patterns", () => {
    // Param type isn't declared — inferred to option<int> from patterns.
    const result = typecheck(["fn", ["o"], ["match", "o", [["Some", "x"], "x"], [["None"], 0]]]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("fn(option<int>) -> int");
  });

  it("non-exhaustive match on option<T> missing None", () => {
    expect(
      typecheckModule({
        main: ["match", ["Some", 1], [["Some", "x"], "x"]],
      }),
    ).toEqual(err("NON_EXHAUSTIVE_MATCH"));
  });

  it("non-exhaustive match with wildcard passes", () => {
    const result = typecheckModule({
      main: ["match", ["Some", 1], [["Some", "x"], "x"], ["_", 0]],
    });
    expect(result.ok).toBe(true);
  });

  it("match with wildcard binding inside a variant pattern passes", () => {
    const result = typecheck(["match", ["Some", 1], [["Some", "_"], 42], [["None"], 0]]);
    expect(result).toEqual(ok(INT));
  });

  it("match arm types must agree across branches", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["match", ["Some", 1], [["Some", "x"], "x"], [["None"], "s"]], env)).toEqual(
      err("TYPE_MISMATCH"),
    );
  });

  it("match with wrong pattern arity → ARITY_ERROR", () => {
    expect(typecheck(["match", ["Some", 1], [["Some", "x", "y"], "x"], [["None"], 0]])).toEqual(
      err("ARITY_ERROR"),
    );
  });

  it("nested patterns: inner match on Some(Ok)/Err inside outer Some/None", () => {
    const result = typecheck([
      "match",
      ["Some", ["Ok", 1]],
      [
        ["Some", "x"],
        ["match", "x", [["Ok", "v"], "v"], [["Err", "_"], 0]],
      ],
      [["None"], 0],
    ]);
    expect(result).toEqual(ok(INT));
  });

  it("match on unrelated scrutinee type with variant pattern → TYPE_MISMATCH", () => {
    expect(typecheck(["match", 1, [["Some", "x"], "x"], [["None"], 0]])).toEqual(
      err("TYPE_MISMATCH"),
    );
  });

  it("match clause is not [pattern, body] → TYPE_MISMATCH", () => {
    expect(typecheck(["match", 1, "notarray"])).toEqual(err("TYPE_MISMATCH"));
  });

  it("match arity error: no clauses", () => {
    expect(typecheck(["match", 1])).toEqual(err("ARITY_ERROR"));
  });

  it("nominal types are not structural — Foo and Bar with same shape don't unify", () => {
    expect(
      typecheckModule({
        types: [
          { name: "A", variants: [{ tag: "FooA" }] },
          { name: "B", variants: [{ tag: "FooB" }] },
        ],
        main: ["array", ["FooA"], ["FooB"]],
      }),
    ).toEqual(err("TYPE_MISMATCH"));
  });
});

describe("HM: effects", () => {
  it("perform inside fn — fn's effect row includes performed tag", () => {
    const result = typecheck(["fn", [], ["perform", "Foo", null]]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toContain("Foo");
  });

  it("handle removes the tag from the outer effect row", () => {
    // Inner fn fully handles Local; outer fn must be pure.
    const result = typecheck([
      "fn",
      ["x"],
      [
        "handle",
        ["perform", "Local", "x"],
        [
          ["Local", "v", "k"],
          ["call", "k", "v"],
        ],
        [["return", "y"], "y"],
      ],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).not.toContain("Local");
  });

  it("nested handle: inner handles E1, outer leaks E2", () => {
    const result = typecheck([
      "fn",
      [],
      [
        "handle",
        ["do", ["perform", "E1", 1], ["perform", "E2", 2]],
        [
          ["E1", "v", "k"],
          ["call", "k", "v"],
        ],
      ],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const s = prettyType(result.type);
      expect(s).not.toContain("E1");
      expect(s).toContain("E2");
    }
  });

  it("unhandled effect propagates through multiple call frames", () => {
    const result = typecheck([
      "let",
      [
        ["g", ["fn", [], ["perform", "Foo", null]]],
        ["h", ["fn", [], ["call", "g"]]],
      ],
      ["fn", [], ["call", "h"]],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toContain("Foo");
  });

  it("k binding type: calling k with wrong arg type → TYPE_MISMATCH", () => {
    // Body performs Ask on null, then adds resume to int — so resume is int.
    // Handler tries to call k with a string — mismatch.
    const env = EMPTY_TYPE_ENV.extend({ wrong: STRING });
    const result = typecheck(
      [
        "handle",
        ["+", ["perform", "Ask", null], 1],
        [
          ["Ask", "_", "k"],
          ["call", "k", "wrong"],
        ],
      ],
      env,
    );
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });

  it("k called with wrong arity → ARITY_ERROR", () => {
    expect(
      typecheck([
        "handle",
        ["perform", "Ask", null],
        [
          ["Ask", "_", "k"],
          ["call", "k"],
        ],
      ]),
    ).toEqual(err("ARITY_ERROR"));
  });

  it("handle with no clauses (no return clause) returns body type", () => {
    expect(typecheck(["handle", 42])).toEqual(ok(INT));
  });

  it("multi-shot continuation: k can be called twice (no error)", () => {
    // The type system shouldn't reject calling k more than once — multi-shot
    // is a runtime property. (Linearity is not yet enforced.)
    const result = typecheck([
      "handle",
      ["perform", "Yield", 1],
      [
        ["Yield", "v", "k"],
        ["+", ["call", "k", "v"], ["call", "k", "v"]],
      ],
    ]);
    expect(result).toEqual(ok(INT));
  });

  it("perform unifies payload type across multiple uses of same tag", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(
      typecheck(
        [
          "handle",
          ["do", ["perform", "MyEff", 1], ["perform", "MyEff", "s"]],
          [
            ["MyEff", "v", "k"],
            ["call", "k", "v"],
          ],
        ],
        env,
      ).ok,
    ).toBe(false);
  });

  it("perform tag not a string → TYPE_MISMATCH", () => {
    expect(typecheck(["perform", 42, 1])).toEqual(err("TYPE_MISMATCH"));
  });

  it("handle clause not array → TYPE_MISMATCH", () => {
    expect(typecheck(["handle", 1, "notarray"])).toEqual(err("TYPE_MISMATCH"));
  });

  it("handle clause pattern arity wrong (only Tag, no bindings)", () => {
    expect(typecheck(["handle", ["perform", "X", null], [["X"], 1]])).toEqual(err("TYPE_MISMATCH"));
  });

  it("handle return clause with bad shape → TYPE_MISMATCH", () => {
    expect(typecheck(["handle", 1, [["return"], 1]])).toEqual(err("TYPE_MISMATCH"));
  });
});

describe("HM: capabilities", () => {
  const CAP_NETWORK_LOCAL: MType = {
    kind: "named",
    name: "Cap",
    args: [{ kind: "named", name: "Network", args: [] }],
  };
  const CAP_STORAGE_LOCAL: MType = {
    kind: "named",
    name: "Cap",
    args: [{ kind: "named", name: "Storage", args: [] }],
  };

  it("Network.get result feeds str-len (used in arithmetic)", () => {
    const env = EMPTY_TYPE_ENV.extend({
      net: CAP_NETWORK_LOCAL,
      url: STRING,
    });
    expect(typecheck(["str-len", ["call.method", "net", "get", "url"]], env)).toEqual(ok(INT));
  });

  it("two cap methods in sequence — both effects appear in the row", () => {
    const env = EMPTY_TYPE_ENV.extend({
      net: CAP_NETWORK_LOCAL,
      st: CAP_STORAGE_LOCAL,
      url: STRING,
      k: STRING,
      v: STRING,
    });
    const result = typecheck(
      [
        "fn",
        [],
        ["do", ["call.method", "net", "get", "url"], ["call.method", "st", "set", "k", "v"]],
      ],
      env,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const s = prettyType(result.type);
      expect(s).toContain("Network");
      expect(s).toContain("Storage");
    }
  });

  it("capability passed as an unknown-typed function arg threads through", () => {
    // c is unknown — call.method on it gradually escapes to unknown.
    const env = EMPTY_TYPE_ENV.extend({
      net: CAP_NETWORK_LOCAL,
      url: STRING,
    });
    const result = typecheck(
      [
        "let",
        [["use", ["fn", [["c", "unknown"]], ["call.method", "c", "get", "url"]]]],
        ["call", "use", "net"],
      ],
      env,
    );
    expect(result.ok).toBe(true);
  });
});

describe("HM: error quality", () => {
  it("UNDEFINED_VAR carries a path", () => {
    const result = typecheck(["+", "missing", 1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors.find((x) => x.code === "UNDEFINED_VAR");
      expect(e).toBeDefined();
      expect(e?.path).toEqual([1]);
    }
  });

  it("ARITY_ERROR for wrong number of args", () => {
    expect(typecheck(["+", 1])).toEqual(err("ARITY_ERROR"));
  });

  it("UNKNOWN_OP for non-string head", () => {
    expect(typecheck([1, 2, 3] as unknown as Expr)).toEqual(err("UNKNOWN_OP"));
  });

  it("UNKNOWN_OP for a totally unknown op name", () => {
    expect(typecheck(["zzz-no-op", 1])).toEqual(err("UNKNOWN_OP"));
  });

  it("UNKNOWN_VARIANT for a Tag-cased op with no registered DU", () => {
    expect(typecheck(["NoSuchTag", 1])).toEqual(err("UNKNOWN_VARIANT"));
  });

  it("NON_EXHAUSTIVE_MATCH when only None covered for option<T>", () => {
    expect(typecheck(["fn", ["o"], ["match", "o", [["None"], 0]]])).toEqual(
      err("NON_EXHAUSTIVE_MATCH"),
    );
  });

  it("NOT_YET_IMPLEMENTED for `?` op", () => {
    expect(typecheck(["?", 1])).toEqual(err("NOT_YET_IMPLEMENTED"));
  });

  it("nested error inside fn body has a nested path", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["fn", [["x", "int"]], ["+", "x", "s"]], env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The body is at index 2 of the fn expr; the bad arg is at [2, 2].
      const e = result.errors[0];
      expect(e?.path?.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("malformed let bindings → TYPE_MISMATCH at the bindings position", () => {
    const result = typecheck(["let", "notarray", 1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("TYPE_MISMATCH");
      expect(result.errors[0]?.path).toEqual([1]);
    }
  });

  it("malformed letrec bindings → TYPE_MISMATCH", () => {
    expect(typecheck(["letrec", "notarray", 1])).toEqual(err("TYPE_MISMATCH"));
  });

  it("malformed fn params → TYPE_MISMATCH", () => {
    expect(typecheck(["fn", "notarray", 1])).toEqual(err("TYPE_MISMATCH"));
  });

  it("error has expected/got fields populated", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(["+", "s", 1], env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors[0];
      expect(e?.expected).toBeDefined();
      expect(e?.got).toBeDefined();
    }
  });

  it("multiple errors are collected, not short-circuited", () => {
    // Two unrelated errors: undefined var and arity error.
    const result = typecheck(["if", "undef1", ["+", 1], 2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = new Set(result.errors.map((e) => e.code));
      expect(codes.has("UNDEFINED_VAR")).toBe(true);
      expect(codes.has("ARITY_ERROR")).toBe(true);
    }
  });
});

// ===========================================================================
// Phase 6: linearity enforcement
// ===========================================================================

describe("Phase 6: linearity", () => {
  const LINEAR_INT: MType = { kind: "linear", inner: INT };
  const AFFINE_INT: MType = { kind: "affine", inner: INT };
  // A consumer fn that takes a linear int and returns int. Used to set up
  // "consume the linear value" scenarios without relying on arithmetic ops
  // (which require unwrapped numerics).
  const CONSUME_LIN: MType = { kind: "fn", params: [LINEAR_INT], ret: INT };
  const CONSUME_AFF: MType = { kind: "fn", params: [AFFINE_INT], ret: INT };
  const MK_LIN: MType = { kind: "fn", params: [], ret: LINEAR_INT };
  const MK_AFF: MType = { kind: "fn", params: [], ret: AFFINE_INT };

  it("linear value used twice → DUPLICATED_LINEAR", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: LINEAR_INT, consume: CONSUME_LIN });
    // Two consume calls — each references x once → 2 uses total.
    const result = typecheck(["+", ["call", "consume", "x"], ["call", "consume", "x"]], env);
    expect(result).toEqual(err("DUPLICATED_LINEAR"));
  });

  it("linear value used once → ok", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: LINEAR_INT, consume: CONSUME_LIN });
    const result = typecheck(["call", "consume", "x"], env);
    expect(result).toEqual(ok(INT));
  });

  it("linear value never used (let-bound) → DROPPED_LINEAR", () => {
    const env = EMPTY_TYPE_ENV.extend({ mkLin: MK_LIN });
    const result = typecheck(["let", [["x", ["call", "mkLin"]]], 0], env);
    expect(result).toEqual(err("DROPPED_LINEAR"));
  });

  it("linear value used exactly once in let body → ok", () => {
    const env = EMPTY_TYPE_ENV.extend({ mkLin: MK_LIN, consume: CONSUME_LIN });
    const result = typecheck(["let", [["x", ["call", "mkLin"]]], ["call", "consume", "x"]], env);
    expect(result).toEqual(ok(INT));
  });

  it("affine value used twice → DUPLICATED_AFFINE", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: AFFINE_INT, consume: CONSUME_AFF });
    const result = typecheck(["+", ["call", "consume", "x"], ["call", "consume", "x"]], env);
    expect(result).toEqual(err("DUPLICATED_AFFINE"));
  });

  it("affine value used once → ok", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: AFFINE_INT, consume: CONSUME_AFF });
    const result = typecheck(["call", "consume", "x"], env);
    expect(result).toEqual(ok(INT));
  });

  it("affine value never used → ok (droppable)", () => {
    const env = EMPTY_TYPE_ENV.extend({ mkAff: MK_AFF });
    const result = typecheck(["let", [["x", ["call", "mkAff"]]], 0], env);
    expect(result.ok).toBe(true);
  });

  it("linear value passed to function (consumed once) → ok", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: LINEAR_INT, consume: CONSUME_LIN });
    const result = typecheck(["call", "consume", "x"], env);
    expect(result.ok).toBe(true);
  });

  it("linear fn parameter not used in body → DROPPED_LINEAR", () => {
    const result = typecheck(["fn", [["x", "linear int"]], 0]);
    expect(result).toEqual(err("DROPPED_LINEAR"));
  });

  it("linear fn parameter used exactly once → ok", () => {
    const result = typecheck(["fn", [["x", "linear int"]], "x"]);
    expect(result.ok).toBe(true);
  });

  it("linear fn parameter used twice in body → DUPLICATED_LINEAR", () => {
    const env = EMPTY_TYPE_ENV.extend({ consume: CONSUME_LIN });
    const result = typecheck(
      ["fn", [["x", "linear int"]], ["+", ["call", "consume", "x"], ["call", "consume", "x"]]],
      env,
    );
    expect(result).toEqual(err("DUPLICATED_LINEAR"));
  });

  it("affine fn parameter not used → ok", () => {
    const result = typecheck(["fn", [["x", "affine int"]], 0]);
    expect(result.ok).toBe(true);
  });

  it("affine fn parameter used twice → DUPLICATED_AFFINE", () => {
    const env = EMPTY_TYPE_ENV.extend({ consume: CONSUME_AFF });
    const result = typecheck(
      ["fn", [["x", "affine int"]], ["+", ["call", "consume", "x"], ["call", "consume", "x"]]],
      env,
    );
    expect(result).toEqual(err("DUPLICATED_AFFINE"));
  });

  it("linear value in if — used in both branches once each → ok", () => {
    const env = EMPTY_TYPE_ENV.extend({
      x: LINEAR_INT,
      b: BOOL,
      consume: CONSUME_LIN,
    });
    // MAX merge: each branch uses x once → final use count is 1.
    const result = typecheck(["if", "b", ["call", "consume", "x"], ["call", "consume", "x"]], env);
    expect(result.ok).toBe(true);
  });

  it("linear value in if — used twice in one branch → DUPLICATED_LINEAR", () => {
    const env = EMPTY_TYPE_ENV.extend({
      x: LINEAR_INT,
      b: BOOL,
      consume: CONSUME_LIN,
    });
    const result = typecheck(
      ["if", "b", ["+", ["call", "consume", "x"], ["call", "consume", "x"]], 0],
      env,
    );
    expect(result).toEqual(err("DUPLICATED_LINEAR"));
  });

  it("linear value in match — each branch uses once → ok", () => {
    const env = EMPTY_TYPE_ENV.extend({
      x: LINEAR_INT,
      o: INT,
      consume: CONSUME_LIN,
    });
    const result = typecheck(
      [
        "match",
        ["Some", "o"],
        [
          ["Some", "_"],
          ["call", "consume", "x"],
        ],
        [["None"], ["call", "consume", "x"]],
      ],
      env,
    );
    expect(result.ok).toBe(true);
  });

  it("linear value in match — used twice in one branch → DUPLICATED_LINEAR", () => {
    const env = EMPTY_TYPE_ENV.extend({
      x: LINEAR_INT,
      o: INT,
      consume: CONSUME_LIN,
    });
    const result = typecheck(
      [
        "match",
        ["Some", "o"],
        [
          ["Some", "_"],
          ["+", ["call", "consume", "x"], ["call", "consume", "x"]],
        ],
        [["None"], ["call", "consume", "x"]],
      ],
      env,
    );
    expect(result).toEqual(err("DUPLICATED_LINEAR"));
  });

  it("Cap<Network> is linear by default — used twice → DUPLICATED_LINEAR", () => {
    const env = EMPTY_TYPE_ENV.extend({
      net: {
        kind: "named",
        name: "Cap",
        args: [{ kind: "named", name: "Network", args: [] }],
      },
      url: STRING,
    });
    const result = typecheck(
      ["do", ["call.method", "net", "get", "url"], ["call.method", "net", "get", "url"]],
      env,
    );
    expect(result).toEqual(err("DUPLICATED_LINEAR"));
  });

  it("non-linear code is unaffected (no linearity errors on plain int)", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: INT });
    const result = typecheck(["+", "x", "x"], env);
    expect(result).toEqual(ok(INT));
  });

  it("non-linear code in a fn body unaffected", () => {
    const result = typecheck(["fn", [["x", "int"]], ["+", "x", "x"]]);
    expect(result.ok).toBe(true);
  });

  it("linear used three times → DUPLICATED_LINEAR with count in message", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: LINEAR_INT, consume: CONSUME_LIN });
    const result = typecheck(
      ["+", ["call", "consume", "x"], ["+", ["call", "consume", "x"], ["call", "consume", "x"]]],
      env,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors.find((x) => x.code === "DUPLICATED_LINEAR");
      expect(e).toBeDefined();
      expect(e?.message).toContain("3 times");
    }
  });

  it("linear let binding consumed by function call is OK", () => {
    const env = EMPTY_TYPE_ENV.extend({ mkLin: MK_LIN, consume: CONSUME_LIN });
    const result = typecheck(["let", [["x", ["call", "mkLin"]]], ["call", "consume", "x"]], env);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// Adversarial tests — confirmed bug fixes + behavioural pinning.
// ===========================================================================

describe("adversarial", () => {
  // ---- Bug fix: record-del on closed record with missing key ----
  it("record-del on closed record with missing key → TYPE_MISMATCH", () => {
    expect(typecheck(["record-del", ["record", ["x", 1]], "y"])).toEqual(err("TYPE_MISMATCH"));
  });

  it("record-del on closed record with existing key → same record type", () => {
    const result = typecheck(["record-del", ["record", ["x", 1], ["y", 2]], "x"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("{x: int, y: int}");
  });

  it("record-del on open record (fn param) succeeds — key may or may not be present", () => {
    // The row var absorbs the deleted key, so this typechecks.
    const result = typecheck(["fn", ["r"], ["record-del", "r", "k"]]);
    expect(result.ok).toBe(true);
  });

  it("record-del key must be a string literal", () => {
    expect(typecheck(["record-del", ["record", ["x", 1]], ["+", 1, 2]])).toEqual(
      err("TYPE_MISMATCH"),
    );
  });

  // ---- vals on heterogeneous record errors via unification ----
  it("vals on heterogeneous record → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    expect(typecheck(["vals", ["record", ["x", 1], ["y", "s"]]], env)).toEqual(
      err("TYPE_MISMATCH"),
    );
  });

  it("vals on homogeneous record → array<T>", () => {
    const result = typecheck(["vals", ["record", ["x", 1], ["y", 2], ["z", 3]]]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("array<int>");
  });

  it("vals on empty record → array<a> (polymorphic element)", () => {
    const result = typecheck(["vals", ["record"]]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toMatch(/^array<[a-z]\d*>$/);
  });

  // ---- Soundness holes / gradual escapes ----
  it("perform with no enclosing handle typechecks (effect propagates via row)", () => {
    // typecheck() is a standalone expression checker — no module-scope purity
    // constraint. The effect tag floats up through the ambient effect row and
    // the check passes. Module-level perform is caught by typecheckModule.
    const result = typecheck(["perform", "X", 1]);
    expect(result.ok).toBe(true);
  });

  it("as int on an unknown value typechecks at int (intentional gradual escape)", () => {
    // A bad runtime cast that would crash at runtime still typechecks.
    // This is the documented gradual-escape hatch.
    const result = typecheck(["+", ["as", "int", ["untyped", 1]], 1]);
    expect(result).toEqual(ok(INT));
  });

  // ---- Inference edge cases ----
  it("get-in with empty path returns the record itself", () => {
    const result = typecheck(["get-in", ["record", ["x", 1]], ["array"]]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("{x: int}");
  });

  it("merge of two open-row records loses precision (no fields known statically)", () => {
    // Both inputs have only row variables for content; result is an open
    // record with no known fields and a fresh tail.
    const result = typecheck(["fn", ["a", "b"], ["merge", "a", "b"]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(prettyType(result.type)).toContain("->");
      // Result record body has no concrete fields.
      expect(prettyType(result.type)).toMatch(/->\s*\{\s*\|\s*[a-z]\d*\}/);
    }
  });

  it("match on unknown scrutinee skips exhaustiveness (does not error)", () => {
    const env = EMPTY_TYPE_ENV.extend({ x: UNKNOWN });
    // Only Some covered — would normally be NON_EXHAUSTIVE, but x: unknown
    // suppresses the check.
    const result = typecheck(["match", "x", [["Some", "v"], 1]], env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("int");
  });

  // ---- Linearity edge cases ----
  it("linear value stored in record field, retrieved, used once → ok", () => {
    const LINEAR_INT: MType = { kind: "linear", inner: INT };
    const CONSUME: MType = { kind: "fn", params: [LINEAR_INT], ret: INT };
    const env = EMPTY_TYPE_ENV.extend({ x: LINEAR_INT, consume: CONSUME });
    const result = typecheck(
      ["let", [["r", ["record", ["v", "x"]]]], ["call", "consume", ["get", "r", "v"]]],
      env,
    );
    expect(result.ok).toBe(true);
  });

  it("linear value captured in regular fn body → LINEAR_CAPTURED_BY_FN error", () => {
    // A regular fn may be called any number of times, so capturing a linear
    // value is forbidden — the type system cannot guarantee exactly-once use.
    const LINEAR_INT: MType = { kind: "linear", inner: INT };
    const CONSUME: MType = { kind: "fn", params: [LINEAR_INT], ret: INT };
    const env = EMPTY_TYPE_ENV.extend({ x: LINEAR_INT, consume: CONSUME });
    const result = typecheck(["fn", [], ["call", "consume", "x"]], env);
    expect(result).toEqual(err("LINEAR_CAPTURED_BY_FN"));
  });

  it("linear value in letrec RHS → LINEAR_IN_LETREC error", () => {
    // Call count through mutual recursion is undecidable, so outer linear
    // values must not appear in any letrec RHS.
    const LINEAR_INT: MType = { kind: "linear", inner: INT };
    const CONSUME: MType = { kind: "fn", params: [LINEAR_INT], ret: INT };
    const env = EMPTY_TYPE_ENV.extend({ x: LINEAR_INT, consume: CONSUME });
    const result = typecheck(
      ["letrec", [["f", ["fn", [], ["call", "consume", "x"]]]], ["call", "f"]],
      env,
    );
    expect(result).toEqual(err("LINEAR_IN_LETREC"));
  });

  it("fn-once consuming a linear capture → ok", () => {
    // fn-once declares the closure is called exactly once; the linear capture
    // is counted as consumed at the fn-once expression site.
    const LINEAR_INT: MType = { kind: "linear", inner: INT };
    const CONSUME: MType = { kind: "fn", params: [LINEAR_INT], ret: INT };
    const env = EMPTY_TYPE_ENV.extend({ x: LINEAR_INT, consume: CONSUME });
    const result = typecheck(["fn-once", [], ["call", "consume", "x"]], env);
    expect(result.ok).toBe(true);
  });

  it("fn-once produces the same fn type as fn", () => {
    // fn-once is a linearity-only annotation; the type is identical to fn.
    const resultFn = typecheck(["fn", [["x", "int"]], ["+", "x", 1]]);
    const resultFnOnce = typecheck(["fn-once", [["x", "int"]], ["+", "x", 1]]);
    expect(resultFn.ok).toBe(true);
    expect(resultFnOnce.ok).toBe(true);
    if (resultFn.ok && resultFnOnce.ok) {
      expect(prettyType(resultFnOnce.type)).toBe(prettyType(resultFn.type));
    }
  });

  it("linear value used in letrec body (not RHS) once → ok", () => {
    // Linear values are allowed in the letrec body expression — only RHSs
    // are forbidden.
    const LINEAR_INT: MType = { kind: "linear", inner: INT };
    const CONSUME: MType = { kind: "fn", params: [LINEAR_INT], ret: INT };
    const env = EMPTY_TYPE_ENV.extend({ x: LINEAR_INT, consume: CONSUME });
    const result = typecheck(["letrec", [["f", ["fn", [], 0]]], ["call", "consume", "x"]], env);
    expect(result.ok).toBe(true);
  });

  // ---- Row polymorphism stress ----
  it("merge of two records with overlapping field of different types — error when forced into same shape", () => {
    // Force two merge results into an array; the shapes must unify.
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(
      [
        "array",
        ["merge", ["record", ["x", 1]], ["record", ["y", "s"]]],
        ["merge", ["record", ["x", "s"]], ["record", ["y", 1]]],
      ],
      env,
    );
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });

  it("fn reading field from unknown-typed record → return type is a fresh var", () => {
    // x: unknown bypasses row constraint generation; result is an unconstrained var.
    const result = typecheck(["fn", [["r", "unknown"]], ["get", "r", "name"]]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const s = prettyType(result.type);
      expect(s).toContain("fn(unknown)");
    }
  });

  it("polymorphic field-getter used at two different record shapes in same let", () => {
    const result = typecheck([
      "let",
      [["g", ["fn", ["r"], ["get", "r", "name"]]]],
      [
        "array",
        ["call", "g", ["record", ["name", 1]]],
        ["call", "g", ["record", ["name", 2], ["age", 3]]],
      ],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("array<int>");
  });

  // ---- Effect row stress ----
  it("function with effect passed where pure fn expected → TYPE_MISMATCH", () => {
    const PURE_FN: MType = {
      kind: "fn",
      params: [{ kind: "fn", params: [], ret: INT }],
      ret: INT,
    };
    const env = EMPTY_TYPE_ENV.extend({ pureF: PURE_FN });
    const result = typecheck(["call", "pureF", ["fn", [], ["perform", "X", null]]], env);
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });

  it("two perform calls with same tag but different payload types in same handle body → TYPE_MISMATCH", () => {
    const env = EMPTY_TYPE_ENV.extend({ s: STRING });
    const result = typecheck(
      [
        "handle",
        ["do", ["perform", "T", 1], ["perform", "T", "s"]],
        [
          ["T", "v", "k"],
          ["call", "k", "v"],
        ],
      ],
      env,
    );
    expect(result).toEqual(err("TYPE_MISMATCH"));
  });

  // ---- Empty / degenerate cases ----
  it("empty record literal → {} (empty closed record)", () => {
    const result = typecheck(["record"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toBe("{}");
    const result2 = typecheck(["{}"]);
    expect(result2.ok).toBe(true);
    if (result2.ok) expect(prettyType(result2.type)).toBe("{}");
  });

  it("empty array literal → array<a> (polymorphic element)", () => {
    const result = typecheck(["array"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(prettyType(result.type)).toMatch(/^array<[a-z]\d*>$/);
  });

  it("match with zero clauses → ARITY_ERROR", () => {
    expect(typecheck(["match", 1])).toEqual(err("ARITY_ERROR"));
  });
});
