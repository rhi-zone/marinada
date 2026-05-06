import { describe, it, expect } from "bun:test";
import { evaluateModule } from "./module.ts";
import type { Module } from "./types.ts";

import type { Expr } from "./types.ts";

// Helper: evaluate a std function call via a module that imports from lib:std.
// Note: in Marinada, bare strings in expressions are variable references, not literals.
// Use non-string values (numbers, booleans, null, arrays) as direct args.
// For string values, use a full module with a let binding.
function callStd(fnName: string, ...args: Expr[]): ReturnType<typeof evaluateModule> {
  const module: Module = {
    imports: [{ from: "lib:std", import: [fnName] }],
    main: ["call", fnName, ...args],
  };
  return evaluateModule(module);
}

// Helper: run a module with lib:std imports and a custom main expression.
function stdModule(imports: string[], main: Expr) {
  const module: Module = {
    imports: [{ from: "lib:std", import: imports }],
    main,
  };
  return evaluateModule(module);
}

describe("lib:std", () => {
  describe("identity", () => {
    it("returns its argument unchanged (int)", () => {
      const r = callStd("identity", 42);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 42n });
    });

    it("returns its argument unchanged (bool)", () => {
      const r = callStd("identity", true);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
    });

    it("returns its argument unchanged (null)", () => {
      const r = callStd("identity", null);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "null" });
    });
  });

  describe("compose", () => {
    it("composes two functions: (f . g)(x) = f(g(x))", () => {
      const r = stdModule(
        ["compose"],
        [
          "let",
          [
            ["double", ["fn", ["x"], ["+", "x", "x"]]],
            ["inc", ["fn", ["x"], ["+", "x", 1]]],
            ["double-then-inc", ["call", "compose", "inc", "double"]],
          ],
          ["call", "double-then-inc", 3],
        ],
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 7n });
    });
  });

  describe("const", () => {
    it("returns the first argument regardless of second", () => {
      const r = stdModule(["const"], ["call", ["call", "const", 42], 99]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 42n });
    });
  });

  describe("flip", () => {
    it("reverses first two arguments of a two-arg function", () => {
      // flipped-sub(3, 10) = sub(10, 3) = 7
      const r = stdModule(
        ["flip"],
        [
          "let",
          [
            ["sub", ["fn", ["a", "b"], ["-", "a", "b"]]],
            ["flipped-sub", ["call", "flip", "sub"]],
          ],
          ["call", "flipped-sub", 3, 10],
        ],
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 7n });
    });
  });

  describe("Option", () => {
    it("is-some returns true for Some", () => {
      const r = callStd("is-some", ["Some", 1]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
    });

    it("is-some returns false for None", () => {
      const r = callStd("is-some", ["None"]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
    });

    it("is-none returns true for None", () => {
      const r = callStd("is-none", ["None"]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
    });

    it("is-none returns false for Some", () => {
      const r = callStd("is-none", ["Some", 1]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
    });

    it("unwrap-or returns inner value for Some", () => {
      const r = stdModule(["unwrap-or"], ["call", "unwrap-or", ["Some", 42], 0]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 42n });
    });

    it("unwrap-or returns default for None", () => {
      const r = stdModule(["unwrap-or"], ["call", "unwrap-or", ["None"], 99]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 99n });
    });

    it("map-option applies f to Some value", () => {
      const r = stdModule(
        ["map-option"],
        ["call", "map-option", ["fn", ["x"], ["+", "x", 1]], ["Some", 5]],
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Some",
          fields: [{ kind: "int", value: 6n }],
        });
    });

    it("map-option passes through None", () => {
      const r = stdModule(
        ["map-option"],
        ["call", "map-option", ["fn", ["x"], ["+", "x", 1]], ["None"]],
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "variant", tag: "None" });
    });

    it("and-then chains Some into another option", () => {
      const r = stdModule(
        ["and-then"],
        ["call", "and-then", ["fn", ["x"], ["Some", ["+", "x", 10]]], ["Some", 5]],
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Some",
          fields: [{ kind: "int", value: 15n }],
        });
    });

    it("and-then short-circuits on None", () => {
      const r = stdModule(
        ["and-then"],
        ["call", "and-then", ["fn", ["x"], ["Some", ["+", "x", 10]]], ["None"]],
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "variant", tag: "None" });
    });

    it("option-or returns Some unchanged", () => {
      const r = stdModule(["option-or"], ["call", "option-or", ["Some", 1], ["None"]]);
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Some",
          fields: [{ kind: "int", value: 1n }],
        });
    });

    it("option-or returns fallback for None", () => {
      const r = stdModule(["option-or"], ["call", "option-or", ["None"], ["Some", 42]]);
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Some",
          fields: [{ kind: "int", value: 42n }],
        });
    });
  });

  describe("Result", () => {
    it("is-ok returns true for Ok", () => {
      const r = callStd("is-ok", ["Ok", 1]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
    });

    it("is-ok returns false for Err", () => {
      // Use a numeric error value to avoid bare-string variable-ref issue
      const r = callStd("is-ok", ["Err", 0]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
    });

    it("is-err returns true for Err", () => {
      const r = callStd("is-err", ["Err", 0]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
    });

    it("is-err returns false for Ok", () => {
      const r = callStd("is-err", ["Ok", 1]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
    });

    it("unwrap-or-else returns Ok value", () => {
      const r = stdModule(
        ["unwrap-or-else"],
        ["call", "unwrap-or-else", ["Ok", 42], ["fn", ["e"], 0]],
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 42n });
    });

    it("unwrap-or-else calls fallback on Err, passing error value", () => {
      const r = stdModule(
        ["unwrap-or-else"],
        ["call", "unwrap-or-else", ["Err", 5], ["fn", ["e"], ["+", "e", 100]]],
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 105n });
    });

    it("map-result applies f to Ok value", () => {
      const r = stdModule(
        ["map-result"],
        ["call", "map-result", ["fn", ["x"], ["+", "x", 1]], ["Ok", 9]],
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Ok",
          fields: [{ kind: "int", value: 10n }],
        });
    });

    it("map-result passes through Err unchanged", () => {
      const r = stdModule(
        ["map-result"],
        ["call", "map-result", ["fn", ["x"], ["+", "x", 1]], ["Err", 7]],
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Err",
          fields: [{ kind: "int", value: 7n }],
        });
    });

    it("map-err transforms Err value", () => {
      const r = stdModule(
        ["map-err"],
        ["call", "map-err", ["fn", ["e"], ["+", "e", 1]], ["Err", 4]],
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Err",
          fields: [{ kind: "int", value: 5n }],
        });
    });

    it("map-err passes Ok through unchanged", () => {
      const r = stdModule(
        ["map-err"],
        ["call", "map-err", ["fn", ["e"], ["+", "e", 1]], ["Ok", 99]],
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Ok",
          fields: [{ kind: "int", value: 99n }],
        });
    });

    it("result-and-then chains Ok into another result", () => {
      const r = stdModule(
        ["result-and-then"],
        ["call", "result-and-then", ["fn", ["x"], ["Ok", ["+", "x", 1]]], ["Ok", 9]],
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Ok",
          fields: [{ kind: "int", value: 10n }],
        });
    });

    it("result-and-then short-circuits on Err", () => {
      const r = stdModule(
        ["result-and-then"],
        ["call", "result-and-then", ["fn", ["x"], ["Ok", ["+", "x", 1]]], ["Err", 3]],
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Err",
          fields: [{ kind: "int", value: 3n }],
        });
    });
  });

  describe("Numeric helpers", () => {
    it("clamp returns value when in range", () => {
      const r = stdModule(["clamp"], ["call", "clamp", 5, 0, 10]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 5n });
    });

    it("clamp clamps to hi when above", () => {
      const r = stdModule(["clamp"], ["call", "clamp", 15, 0, 10]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 10n });
    });

    it("clamp clamps to lo when below", () => {
      const r = stdModule(["clamp"], ["call", "clamp", -5, 0, 10]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 0n });
    });

    it("between? returns true when in range (inclusive)", () => {
      const r = stdModule(["between?"], ["call", "between?", 5, 0, 10]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
    });

    it("between? returns true at boundary", () => {
      const r = stdModule(["between?"], ["call", "between?", 10, 0, 10]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
    });

    it("between? returns false when out of range", () => {
      const r = stdModule(["between?"], ["call", "between?", 11, 0, 10]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
    });

    it("sign returns -1 for negative", () => {
      const r = callStd("sign", -5);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: -1n });
    });

    it("sign returns 1 for positive", () => {
      const r = callStd("sign", 7);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 1n });
    });

    it("sign returns 0 for zero", () => {
      const r = callStd("sign", 0);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 0n });
    });
  });

  describe("String helpers", () => {
    it("str-empty? returns true for empty string", () => {
      // Pass string via let binding — bare strings are variable refs in Marinada
      const r = stdModule(
        ["str-empty?"],
        ["let", [["s", ["slice", ["to-string", null], 0, 0]]], ["call", "str-empty?", "s"]],
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
    });

    it("str-empty? returns false for non-empty string", () => {
      const r = stdModule(
        ["str-empty?"],
        ["let", [["s", ["to-string", 42]]], ["call", "str-empty?", "s"]],
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
    });

    it('bool->str converts true to "true"', () => {
      const r = callStd("bool->str", true);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "string", value: "true" });
    });

    it('bool->str converts false to "false"', () => {
      const r = callStd("bool->str", false);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "string", value: "false" });
    });
  });

  describe("Higher-order collection functions", () => {
    describe("map", () => {
      it("maps a function over an array", () => {
        const r = stdModule(
          ["map"],
          ["call", "map", ["fn", ["x"], ["+", "x", 1]], ["array", 1, 2, 3]],
        );
        expect(r.ok).toBe(true);
        if (r.ok)
          expect(r.value).toMatchObject({
            kind: "array",
            value: [
              { kind: "int", value: 2n },
              { kind: "int", value: 3n },
              { kind: "int", value: 4n },
            ],
          });
      });

      it("returns empty array for empty input", () => {
        const r = stdModule(["map"], ["call", "map", ["fn", ["x"], ["+", "x", 1]], ["array"]]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "array", value: [] });
      });
    });

    describe("filter", () => {
      it("keeps only elements matching the predicate", () => {
        const r = stdModule(
          ["filter"],
          ["call", "filter", ["fn", ["x"], [">", "x", 2]], ["array", 1, 2, 3, 4]],
        );
        expect(r.ok).toBe(true);
        if (r.ok)
          expect(r.value).toMatchObject({
            kind: "array",
            value: [
              { kind: "int", value: 3n },
              { kind: "int", value: 4n },
            ],
          });
      });

      it("returns empty array when nothing matches", () => {
        const r = stdModule(
          ["filter"],
          ["call", "filter", ["fn", ["x"], [">", "x", 10]], ["array", 1, 2, 3]],
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "array", value: [] });
      });
    });

    describe("reduce", () => {
      it("reduces an array to a single value", () => {
        const r = stdModule(
          ["reduce"],
          ["call", "reduce", ["fn", ["acc", "x"], ["+", "acc", "x"]], 0, ["array", 1, 2, 3, 4]],
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 10n });
      });

      it("returns init for empty array", () => {
        const r = stdModule(
          ["reduce"],
          ["call", "reduce", ["fn", ["acc", "x"], ["+", "acc", "x"]], 99, ["array"]],
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 99n });
      });
    });

    describe("find", () => {
      it("returns first matching element", () => {
        const r = stdModule(
          ["find"],
          ["call", "find", ["fn", ["x"], [">", "x", 2]], ["array", 1, 2, 3, 4]],
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 3n });
      });

      it("returns null when no element matches", () => {
        const r = stdModule(
          ["find"],
          ["call", "find", ["fn", ["x"], [">", "x", 10]], ["array", 1, 2, 3]],
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "null" });
      });
    });

    describe("every", () => {
      it("returns true when all elements match", () => {
        const r = stdModule(
          ["every"],
          ["call", "every", ["fn", ["x"], [">", "x", 0]], ["array", 1, 2, 3]],
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
      });

      it("returns false when any element fails", () => {
        const r = stdModule(
          ["every"],
          ["call", "every", ["fn", ["x"], [">", "x", 1]], ["array", 1, 2, 3]],
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
      });

      it("returns true for empty array", () => {
        const r = stdModule(["every"], ["call", "every", ["fn", ["x"], [">", "x", 0]], ["array"]]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
      });
    });

    describe("any", () => {
      it("returns true when at least one element matches", () => {
        const r = stdModule(
          ["any"],
          ["call", "any", ["fn", ["x"], [">", "x", 2]], ["array", 1, 2, 3]],
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
      });

      it("returns false when no element matches", () => {
        const r = stdModule(
          ["any"],
          ["call", "any", ["fn", ["x"], [">", "x", 10]], ["array", 1, 2, 3]],
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
      });

      it("returns false for empty array", () => {
        const r = stdModule(["any"], ["call", "any", ["fn", ["x"], [">", "x", 0]], ["array"]]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
      });
    });

    describe("flat-map", () => {
      it("maps and flattens one level", () => {
        const r = stdModule(
          ["flat-map"],
          ["call", "flat-map", ["fn", ["x"], ["array", "x", ["+", "x", 10]]], ["array", 1, 2]],
        );
        expect(r.ok).toBe(true);
        if (r.ok)
          expect(r.value).toMatchObject({
            kind: "array",
            value: [
              { kind: "int", value: 1n },
              { kind: "int", value: 11n },
              { kind: "int", value: 2n },
              { kind: "int", value: 12n },
            ],
          });
      });

      it("returns empty array for empty input", () => {
        const r = stdModule(
          ["flat-map"],
          ["call", "flat-map", ["fn", ["x"], ["array", "x"]], ["array"]],
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "array", value: [] });
      });
    });

    describe("includes", () => {
      it("returns true when value is present", () => {
        const r = stdModule(["includes"], ["call", "includes", ["array", 1, 2, 3], 2]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: true });
      });

      it("returns false when value is absent", () => {
        const r = stdModule(["includes"], ["call", "includes", ["array", 1, 2, 3], 5]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
      });

      it("returns false for empty array", () => {
        const r = stdModule(["includes"], ["call", "includes", ["array"], 1]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "bool", value: false });
      });
    });

    describe("index-of", () => {
      it("returns index of first matching value", () => {
        const r = stdModule(["index-of"], ["call", "index-of", ["array", 10, 20, 30], 20]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 1n });
      });

      it("returns -1 when value is not found", () => {
        const r = stdModule(["index-of"], ["call", "index-of", ["array", 10, 20, 30], 99]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: -1n });
      });

      it("returns index of first occurrence for duplicates", () => {
        const r = stdModule(["index-of"], ["call", "index-of", ["array", 5, 5, 5], 5]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ kind: "int", value: 0n });
      });
    });
  });

  describe("some / none / ok / err constructors", () => {
    it("some wraps a value in Some", () => {
      const r = callStd("some", 5);
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Some",
          fields: [{ kind: "int", value: 5n }],
        });
    });

    it("none is the None variant", () => {
      const r = stdModule(["none"], "none");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject({ kind: "variant", tag: "None", fields: [] });
    });

    it("ok wraps a value in Ok", () => {
      const r = callStd("ok", 42);
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Ok",
          fields: [{ kind: "int", value: 42n }],
        });
    });

    it("err wraps a numeric error in Err", () => {
      const r = callStd("err", 404);
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          kind: "variant",
          tag: "Err",
          fields: [{ kind: "int", value: 404n }],
        });
    });
  });
});
