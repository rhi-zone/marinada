import { describe, it, expect } from "bun:test";
import { evaluateModule, typecheckModule } from "./module.ts";
import type { Module } from "./types.ts";
import type { Value } from "./value.ts";

// --- Value helpers ---

function int(n: number | bigint): Value {
  return { kind: "int", value: typeof n === "bigint" ? n : BigInt(n) };
}

function variant(tag: string, ...fields: Value[]): Value {
  return { kind: "variant", tag, fields };
}

const NULL: Value = { kind: "null" };

// --- evaluateModule ---

describe("evaluateModule", () => {
  it("evaluates main for a module with no imports and no types", () => {
    const module: Module = {
      main: ["+", 1, 2],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: int(3) });
  });

  it("evaluates a null literal main", () => {
    const module: Module = {
      main: null,
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: NULL });
  });

  it("bare string main fails as undefined variable (strings are variable references)", () => {
    const module: Module = {
      main: "hello",
    };
    // bare string = variable lookup; undefined var is an error
    const result = evaluateModule(module);
    expect(result).toMatchObject({ ok: false });
  });

  it("evaluates a module with type definitions — variant constructors work in main", () => {
    const module: Module = {
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
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: variant("Circle", { kind: "float", value: 1.5 }) });
  });

  it("evaluates a module with no-field variant constructor", () => {
    const module: Module = {
      types: [
        {
          name: "Color",
          variants: [{ tag: "Red" }, { tag: "Green" }, { tag: "Blue" }],
        },
      ],
      main: ["Red"],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: variant("Red") });
  });

  it("evaluates lib:std import — None tag works", () => {
    const module: Module = {
      imports: [{ from: "lib:std", import: ["None", "Some", "Ok", "Err"] }],
      main: ["None"],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: variant("None") });
  });

  it("evaluates lib:std import — Some tag works", () => {
    const module: Module = {
      imports: [{ from: "lib:std", import: ["Some"] }],
      main: ["Some", 42],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: variant("Some", int(42)) });
  });

  it("evaluates lib:std import — Ok and Err tags work", () => {
    const okModule: Module = {
      imports: [{ from: "lib:std", import: ["Ok", "Err"] }],
      main: ["Ok", 1],
    };
    const errModule: Module = {
      imports: [{ from: "lib:std", import: ["Ok", "Err"] }],
      main: ["Err", 0],
    };
    expect(evaluateModule(okModule)).toEqual({
      ok: true,
      value: variant("Ok", int(1)),
    });
    expect(evaluateModule(errModule)).toEqual({
      ok: true,
      value: variant("Err", int(0)),
    });
  });

  it("errors MODULE_NOT_FOUND on unknown import scheme without a resolver", () => {
    const module: Module = {
      imports: [
        { from: "local:./my-types.json", import: ["MyType"] },
        { from: "https://example.com/types.json", import: ["OtherType"] },
      ],
      main: 99,
    };
    const result = evaluateModule(module);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error.code).toBe("MODULE_NOT_FOUND");
  });

  it("errors MODULE_NOT_FOUND on unknown lib: scheme without a resolver", () => {
    const module: Module = {
      imports: [{ from: "lib:matrix", import: ["MatrixEvent"] }],
      main: 0,
    };
    const result = evaluateModule(module);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error.code).toBe("MODULE_NOT_FOUND");
  });

  it("exports list is stored on the module and accessible", () => {
    const module: Module = {
      exports: ["Foo", "bar"],
      main: 1,
    };
    expect(module.exports).toEqual(["Foo", "bar"]);
    const result = evaluateModule(module);
    expect(result).toMatchObject({ ok: true });
  });

  it("uses match with a variant from type defs", () => {
    const module: Module = {
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
        ["Circle", 3.5],
        [
          ["Circle", "r"],
          ["*", "r", "r"],
        ],
        [
          ["Rect", "w", "h"],
          ["*", "w", "h"],
        ],
      ],
    };
    const result = evaluateModule(module);
    expect(result).toEqual({ ok: true, value: { kind: "float", value: 12.25 } });
  });
});

// --- typecheckModule ---

describe("typecheckModule", () => {
  it("type-checks a simple main with no imports or types", () => {
    const module: Module = {
      main: ["+", 1, 2],
    };
    const result = typecheckModule(module);
    expect(result).toEqual({ ok: true, type: { kind: "int" } });
  });

  it("type-checks a null literal", () => {
    const module: Module = {
      main: null,
    };
    expect(typecheckModule(module)).toEqual({ ok: true, type: { kind: "null" } });
  });

  it("reports error for undefined variable in main", () => {
    const module: Module = {
      main: "unknownVar",
    };
    const result = typecheckModule(module);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("UNDEFINED_VAR");
    }
  });

  it("type-checks module with type definitions — variant constructor produces named type", () => {
    const module: Module = {
      types: [
        {
          name: "Color",
          variants: [{ tag: "Red" }, { tag: "Green" }, { tag: "Blue" }],
        },
      ],
      // Phase 3: constructors are not first-class values; they're invoked as ["Red"].
      main: ["Red"],
    };
    const result = typecheckModule(module);
    expect(result).toEqual({
      ok: true,
      type: { kind: "named", name: "Color", args: [] },
    });
  });

  it("type-checks variant constructor call with type defs in scope", () => {
    const module: Module = {
      types: [
        {
          name: "Shape",
          variants: [{ tag: "Circle", fields: [["radius", "float"]] }],
        },
      ],
      main: ["Circle", 1.5],
    };
    const result = typecheckModule(module);
    expect(result).toEqual({
      ok: true,
      type: { kind: "named", name: "Shape", args: [] },
    });
  });

  it("type-checks module that uses None constructor (option<T> from lib:std)", () => {
    const module: Module = {
      // lib:std types (option, result) are pre-registered; explicit import is
      // not required for type checking constructors.
      main: ["None"],
    };
    const result = typecheckModule(module);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.type.kind).toBe("named");
      if (result.type.kind === "named") {
        expect(result.type.name).toBe("option");
        expect(result.type.args.length).toBe(1);
      }
    }
  });

  it("type-checks module that uses Some constructor", () => {
    const module: Module = {
      main: ["Some", 42],
    };
    const result = typecheckModule(module);
    expect(result).toEqual({
      ok: true,
      type: { kind: "named", name: "option", args: [{ kind: "int" }] },
    });
  });

  it("errors MODULE_NOT_FOUND on unknown import scheme without a resolver", () => {
    const module: Module = {
      imports: [{ from: "local:./foo.json", import: ["MyType"] }],
      main: 42,
    };
    const result = typecheckModule(module);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "MODULE_NOT_FOUND")).toBe(true);
    }
  });

  it("errors MODULE_NOT_FOUND on https: import scheme without a resolver", () => {
    const module: Module = {
      imports: [{ from: "https://example.com/types.json", import: ["OtherType"] }],
      main: true,
    };
    const result = typecheckModule(module);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "MODULE_NOT_FOUND")).toBe(true);
    }
  });

  it("reports type error in main even with valid imports", () => {
    const module: Module = {
      imports: [{ from: "lib:std", import: ["None"] }],
      main: ["+", "notANumber", 1],
    };
    const result = typecheckModule(module);
    // "notANumber" is an undefined variable (not in env), which produces UNDEFINED_VAR not TYPE_MISMATCH
    // but arithmetic on unknown is valid (gradual typing), so errors come from UNDEFINED_VAR
    expect(result).toMatchObject({ ok: false });
  });

  it("exports list is stored and accessible — typecheckModule succeeds when exports are bound", () => {
    const module: Module = {
      exports: ["foo", "bar"],
      main: [
        "let",
        [
          ["foo", 1],
          ["bar", 2],
        ],
        123,
      ],
    };
    const result = typecheckModule(module);
    expect(result).toMatchObject({ ok: true, type: { kind: "int" } });
    expect(module.exports).toEqual(["foo", "bar"]);
  });

  it("emits UNDEFINED_EXPORT when an exported name is never bound", () => {
    const module: Module = {
      exports: ["missing"],
      main: 123,
    };
    const result = typecheckModule(module);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "UNDEFINED_EXPORT")).toBe(true);
    }
  });
});

// --- ModuleResolver — Phase 1 ---

describe("evaluateModule with ModuleResolver", () => {
  it("resolves a basic non-lib:std import and uses the imported value in main", () => {
    const dep: Module = {
      exports: ["x"],
      main: ["let", [["x", 42]], 0],
    };
    const root: Module = {
      imports: [{ from: "local:./dep.json", import: ["x"] }],
      main: ["+", "x", 1],
    };
    const result = evaluateModule(root, {
      resolver: (from) => (from === "local:./dep.json" ? dep : null),
    });
    expect(result).toEqual({ ok: true, value: int(43) });
  });

  it("returns MODULE_NOT_FOUND when resolver returns null", () => {
    const root: Module = {
      imports: [{ from: "local:./missing.json", import: ["x"] }],
      main: 0,
    };
    const result = evaluateModule(root, { resolver: () => null });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error.code).toBe("MODULE_NOT_FOUND");
  });

  it("returns UNDEFINED_EXPORT when an imported name is not in the module's exports", () => {
    const dep: Module = {
      exports: ["x"],
      main: ["let", [["x", 1]], 0],
    };
    const root: Module = {
      imports: [{ from: "local:./dep.json", import: ["y"] }],
      main: 0,
    };
    const result = evaluateModule(root, { resolver: () => dep });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error.code).toBe("UNDEFINED_EXPORT");
  });

  it("diamond import — resolver called once per unique path (D resolved once)", () => {
    const calls: string[] = [];
    const D: Module = { exports: ["d"], main: ["let", [["d", 7]], 0] };
    const B: Module = {
      imports: [{ from: "local:D", import: ["d"] }],
      exports: ["b"],
      main: ["let", [["b", ["+", "d", 1]]], 0],
    };
    const C: Module = {
      imports: [{ from: "local:D", import: ["d"] }],
      exports: ["c"],
      main: ["let", [["c", ["+", "d", 2]]], 0],
    };
    const A: Module = {
      imports: [
        { from: "local:B", import: ["b"] },
        { from: "local:C", import: ["c"] },
      ],
      main: ["+", "b", "c"],
    };
    const result = evaluateModule(A, {
      resolver: (from) => {
        calls.push(from);
        if (from === "local:D") return D;
        if (from === "local:B") return B;
        if (from === "local:C") return C;
        return null;
      },
    });
    // b = d+1 = 8, c = d+2 = 9, b+c = 17
    expect(result).toEqual({ ok: true, value: int(17) });
    // D should be resolved once (cache hit on second sighting).
    const dCalls = calls.filter((c) => c === "local:D");
    expect(dCalls.length).toBe(1);
  });

  it("user resolver is called first for lib:std; defaultResolver handles it when user returns null", () => {
    let called = false;
    const root: Module = {
      imports: [{ from: "lib:std", import: ["Some"] }],
      main: ["Some", 1],
    };
    const result = evaluateModule(root, {
      resolver: () => {
        called = true;
        return null; // defer to defaultResolver
      },
    });
    expect(called).toBe(true); // user resolver is tried first
    expect(result).toEqual({ ok: true, value: variant("Some", int(1)) });
  });
});

describe("typecheckModule with ModuleResolver", () => {
  it("imports a value and gives it the correct type", () => {
    const dep: Module = {
      exports: ["x"],
      main: ["let", [["x", 42]], 0],
    };
    const root: Module = {
      imports: [{ from: "local:dep", import: ["x"] }],
      main: ["+", "x", 1],
    };
    const result = typecheckModule(root, { resolver: () => dep });
    expect(result).toMatchObject({ ok: true, type: { kind: "int" } });
  });

  it("flags TYPE_MISMATCH when imported value is used at the wrong type", () => {
    // dep exports `b` of type bool; root tries to use it as the condition
    // value of `+`, which expects numeric operands.
    const dep: Module = {
      exports: ["b"],
      main: ["let", [["b", true]], 0],
    };
    const root: Module = {
      imports: [{ from: "local:dep", import: ["b"] }],
      main: ["+", "b", 1],
    };
    const result = typecheckModule(root, { resolver: () => dep });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "TYPE_MISMATCH")).toBe(true);
    }
  });

  it("returns MODULE_NOT_FOUND error and types imported names as unknown when resolver returns null", () => {
    const root: Module = {
      imports: [{ from: "local:missing", import: ["x"] }],
      // x is unknown — arithmetic on unknown is allowed in gradual mode.
      main: ["+", "x", 1],
    };
    const result = typecheckModule(root, { resolver: () => null });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "MODULE_NOT_FOUND")).toBe(true);
    }
  });

  it("populates the exports map in the success result", () => {
    const dep: Module = {
      exports: ["x", "y"],
      main: [
        "let",
        [
          ["x", 1],
          ["y", true],
        ],
        0,
      ],
    };
    const result = typecheckModule(dep);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exports).toBeDefined();
      expect(result.exports?.get("x")).toEqual({ kind: "int" });
      expect(result.exports?.get("y")).toEqual({ kind: "bool" });
    }
  });

  it("imports a DU constructor from another module and uses it", () => {
    const dep: Module = {
      types: [
        {
          name: "Shape",
          variants: [{ tag: "Circle", fields: [["r", "float"]] }],
        },
      ],
      exports: [],
      main: 0,
    };
    const root: Module = {
      imports: [{ from: "local:shapes", import: [] }],
      main: ["Circle", 1.5],
    };
    const result = typecheckModule(root, { resolver: () => dep });
    expect(result).toMatchObject({
      ok: true,
      type: { kind: "named", name: "Shape", args: [] },
    });
  });
});

// --- Phase 2 — polymorphic imports + export validation ---

describe("typecheckModule — polymorphic imports", () => {
  it("imports a polymorphic identity and instantiates it at two different types", () => {
    // dep exports `id = fn(x) -> x`. With generalization, `id` has scheme
    // `forall a. fn(a) -> a`. The importer uses it at both int and bool in
    // the same expression — both call sites must typecheck independently.
    const dep: Module = {
      exports: ["id"],
      main: ["let", [["id", ["fn", ["x"], "x"]]], 0],
    };
    const root: Module = {
      imports: [{ from: "local:dep", import: ["id"] }],
      // Use id at int and bool, then reduce to int.
      main: ["if", ["call", "id", true], ["call", "id", 1], ["call", "id", 2]],
    };
    const result = typecheckModule(root, { resolver: () => dep });
    expect(result).toMatchObject({ ok: true, type: { kind: "int" } });
  });
});

describe("typecheckModule — exports map completeness", () => {
  it("exports map contains all top-level let bindings listed in exports", () => {
    const dep: Module = {
      exports: ["x", "y", "z"],
      main: [
        "let",
        [
          ["x", 1],
          ["y", true],
          ["z", 3.14],
        ],
        0,
      ],
    };
    const result = typecheckModule(dep);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exports?.get("x")).toEqual({ kind: "int" });
      expect(result.exports?.get("y")).toEqual({ kind: "bool" });
      expect(result.exports?.get("z")).toEqual({ kind: "float" });
    }
  });

  it("UNDEFINED_EXPORT when an exported name is bound only inside a nested let", () => {
    // `inner` is defined inside a non-top-level let and so isn't reachable
    // by peeling — Phase 2 should report UNDEFINED_EXPORT rather than
    // silently producing a missing entry in the exports map.
    const dep: Module = {
      exports: ["inner"],
      main: ["let", [["x", ["let", [["inner", 1]], "inner"]]], "x"],
    };
    const result = typecheckModule(dep);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "UNDEFINED_EXPORT")).toBe(true);
    }
  });
});

// --- Phase 3 — cycle handling ---

describe("typecheckModule — cycle handling", () => {
  it("two modules with mutually-recursive functions typecheck", () => {
    // A imports `g` from B; B imports `f` from A. Both f and g are
    // functions. The cycle is closed via placeholder unification.
    const A: Module = {
      imports: [{ from: "local:B", import: ["g"] }],
      exports: ["f"],
      main: ["let", [["f", ["fn", ["n"], ["call", "g", "n"]]]], 0],
    };
    const B: Module = {
      imports: [{ from: "local:A", import: ["f"] }],
      exports: ["g"],
      main: ["let", [["g", ["fn", ["n"], ["+", "n", 1]]]], 0],
    };
    const result = typecheckModule(A, {
      resolver: (from) => (from === "local:A" ? A : from === "local:B" ? B : null),
    });
    expect(result.ok).toBe(true);
  });

  it("cycle with type mismatch reports TYPE_MISMATCH at boundary", () => {
    // A expects `b` from B to be int (uses + on it). B exports b as a
    // bool. The unification at the cycle boundary (or the use site)
    // should produce a TYPE_MISMATCH.
    const A: Module = {
      imports: [{ from: "local:B", import: ["b"] }],
      exports: ["a"],
      main: ["let", [["a", ["+", "b", 1]]], 0],
    };
    const B: Module = {
      imports: [{ from: "local:A", import: ["a"] }],
      exports: ["b"],
      main: ["let", [["b", true]], 0],
    };
    const result = typecheckModule(A, {
      resolver: (from) => (from === "local:A" ? A : from === "local:B" ? B : null),
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "TYPE_MISMATCH")).toBe(true);
    }
  });

  it("three-module chain A -> B -> C -> A resolves correctly", () => {
    const A: Module = {
      imports: [{ from: "local:B", import: ["b"] }],
      exports: ["a"],
      main: ["let", [["a", ["fn", ["n"], ["call", "b", "n"]]]], 0],
    };
    const B: Module = {
      imports: [{ from: "local:C", import: ["c"] }],
      exports: ["b"],
      main: ["let", [["b", ["fn", ["n"], ["call", "c", "n"]]]], 0],
    };
    const C: Module = {
      imports: [{ from: "local:A", import: ["a"] }],
      exports: ["c"],
      main: ["let", [["c", ["fn", ["n"], ["+", "n", 1]]]], 0],
    };
    const result = typecheckModule(A, {
      resolver: (from) =>
        from === "local:A" ? A : from === "local:B" ? B : from === "local:C" ? C : null,
    });
    expect(result.ok).toBe(true);
  });

  it("self-import (A imports from A) is handled as a cycle", () => {
    const A: Module = {
      imports: [{ from: "local:A", import: ["g"] }],
      exports: ["g"],
      main: ["let", [["g", ["fn", ["n"], ["+", "n", 1]]]], 0],
    };
    const result = typecheckModule(A, { resolver: () => A });
    expect(result.ok).toBe(true);
  });
});

describe("evaluateModule — cycle handling", () => {
  it("two modules with mutually-recursive functions evaluate", () => {
    // f(n): if n <= 0 then 0 else g(n - 1)
    // g(n): if n <= 0 then 1 else f(n - 1)
    const A: Module = {
      imports: [{ from: "local:B", import: ["g"] }],
      exports: ["f"],
      main: [
        "let",
        [["f", ["fn", ["n"], ["if", ["<=", "n", 0], 0, ["call", "g", ["-", "n", 1]]]]]],
        ["call", "f", 3],
      ],
    };
    const B: Module = {
      imports: [{ from: "local:A", import: ["f"] }],
      exports: ["g"],
      main: [
        "let",
        [["g", ["fn", ["n"], ["if", ["<=", "n", 0], 1, ["call", "f", ["-", "n", 1]]]]]],
        0,
      ],
    };
    const result = evaluateModule(A, {
      resolver: (from) => (from === "local:A" ? A : from === "local:B" ? B : null),
    });
    // f(3) -> g(2) -> f(1) -> g(0) -> 1
    expect(result).toMatchObject({ ok: true, value: int(1) });
  });

  it("circular non-function dependency surfaces CIRCULAR_DEPENDENCY", () => {
    // A imports value `b` from B before B has bound it; B imports value `a`
    // from A. Reading from an in-progress cache entry that hasn't yet bound
    // the requested name produces CIRCULAR_DEPENDENCY rather than looping.
    const A: Module = {
      imports: [{ from: "local:B", import: ["b"] }],
      exports: ["a"],
      main: ["let", [["a", ["+", "b", 1]]], 0],
    };
    const B: Module = {
      imports: [{ from: "local:A", import: ["a"] }],
      exports: ["b"],
      main: ["let", [["b", ["+", "a", 1]]], 0],
    };
    const result = evaluateModule(A, {
      resolver: (from) => (from === "local:A" ? A : from === "local:B" ? B : null),
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.code).toBe("CIRCULAR_DEPENDENCY");
    }
  });
});
