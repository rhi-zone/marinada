import { describe, it, expect } from "bun:test";
import { evaluateModuleAsync } from "./module.ts";
import { mapResolver, composeAsyncResolvers } from "./resolvers.ts";
import type { Module } from "./types.ts";
import type { Value } from "./value.ts";

// --- Value helpers ---

function int(n: number | bigint): Value {
  return { kind: "int", value: typeof n === "bigint" ? n : BigInt(n) };
}

const NULL: Value = { kind: "null" };

// --- evaluateModuleAsync ---

describe("evaluateModuleAsync", () => {
  it("evaluates a simple module with no imports (no resolver needed)", async () => {
    const module: Module = { main: ["+", 1, 2] };
    const result = await evaluateModuleAsync(module);
    expect(result).toEqual({ ok: true, value: int(3) });
  });

  it("evaluates a null literal main", async () => {
    const module: Module = { main: null };
    const result = await evaluateModuleAsync(module);
    expect(result).toEqual({ ok: true, value: NULL });
  });

  it("works with a sync resolver (backward compat — every Resolver is an AsyncResolver)", async () => {
    const libMod: Module = {
      main: ["let", [["add", ["fn", ["x", "y"], ["+", "x", "y"]]]], null],
      exports: ["add"],
    };
    const dep = mapResolver({ "local:math": libMod });
    const module: Module = {
      imports: [{ from: "local:math", import: ["add"] }],
      main: ["call", "add", 3, 4],
    };
    const result = await evaluateModuleAsync(module, { resolver: dep });
    expect(result).toEqual({ ok: true, value: int(7) });
  });

  it("works with an async resolver (resolver returns a Promise)", async () => {
    const libMod: Module = {
      main: ["let", [["double", ["fn", ["x"], ["*", "x", 2]]]], null],
      exports: ["double"],
    };
    const asyncResolver = async (path: string): Promise<Module | null> => {
      if (path === "async:math") return libMod;
      return null;
    };
    const module: Module = {
      imports: [{ from: "async:math", import: ["double"] }],
      main: ["call", "double", 5],
    };
    const result = await evaluateModuleAsync(module, { resolver: asyncResolver });
    expect(result).toEqual({ ok: true, value: int(10) });
  });

  it("evaluates with lib:std available (libStdResolver works as AsyncResolver)", async () => {
    const module: Module = {
      imports: [{ from: "lib:std", import: ["map"] }],
      main: ["call", "map", ["fn", ["x"], ["*", "x", 2]], ["array", 1, 2, 3]],
    };
    // No resolver provided — lib:std is composed in automatically
    const result = await evaluateModuleAsync(module);
    expect(result.ok).toBe(true);
  });

  it("lib:std still works when a custom resolver is provided", async () => {
    const customMod: Module = {
      main: ["let", [["ten", 10]], null],
      exports: ["ten"],
    };
    const customResolver = (path: string): Module | null => {
      if (path === "local:constants") return customMod;
      return null;
    };
    const module: Module = {
      imports: [
        { from: "local:constants", import: ["ten"] },
        { from: "lib:std", import: ["identity"] },
      ],
      main: ["call", "identity", "ten"],
    };
    const result = await evaluateModuleAsync(module, { resolver: customResolver });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(int(10));
    }
  });

  it("returns MODULE_NOT_FOUND when async resolver returns null", async () => {
    const asyncResolver = async (_path: string): Promise<Module | null> => null;
    const module: Module = {
      imports: [{ from: "missing:mod", import: ["foo"] }],
      main: "foo",
    };
    const result = await evaluateModuleAsync(module, { resolver: asyncResolver });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODULE_NOT_FOUND");
    }
  });

  it("cycle detection still works across async resolution", async () => {
    // Module A imports value `b` from B before B has bound it; B imports value
    // `a` from A. This is a non-function cycle — CIRCULAR_DEPENDENCY.
    const modA: Module = {
      imports: [{ from: "local:B", import: ["b"] }],
      exports: ["a"],
      main: ["let", [["a", ["+", "b", 1]]], 0],
    };
    const modB: Module = {
      imports: [{ from: "local:A", import: ["a"] }],
      exports: ["b"],
      main: ["let", [["b", ["+", "a", 1]]], 0],
    };
    const asyncResolver = async (path: string): Promise<Module | null> => {
      if (path === "local:A") return modA;
      if (path === "local:B") return modB;
      return null;
    };
    const result = await evaluateModuleAsync(modA, { resolver: asyncResolver });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CIRCULAR_DEPENDENCY");
    }
  });

  it("handles a chain of async-resolved imports", async () => {
    const modC: Module = {
      main: ["let", [["cVal", 100]], null],
      exports: ["cVal"],
    };
    const modB: Module = {
      imports: [{ from: "local:c", import: ["cVal"] }],
      main: ["let", [["bVal", ["*", "cVal", 2]]], null],
      exports: ["bVal"],
    };
    const asyncResolver = async (path: string): Promise<Module | null> => {
      // Simulate async delay
      await Promise.resolve();
      if (path === "local:b") return modB;
      if (path === "local:c") return modC;
      return null;
    };
    const module: Module = {
      imports: [{ from: "local:b", import: ["bVal"] }],
      main: ["*", "bVal", 3],
    };
    const result = await evaluateModuleAsync(module, { resolver: asyncResolver });
    expect(result).toEqual({ ok: true, value: int(600) }); // 100 * 2 * 3
  });

  it("composeAsyncResolvers works as the resolver for evaluateModuleAsync", async () => {
    const modA: Module = {
      main: ["let", [["x", 42]], null],
      exports: ["x"],
    };
    const resolver = composeAsyncResolvers(
      async (path) => (path === "local:a" ? modA : null),
      async (_path) => null,
    );
    const module: Module = {
      imports: [{ from: "local:a", import: ["x"] }],
      main: "x",
    };
    const result = await evaluateModuleAsync(module, { resolver });
    expect(result).toEqual({ ok: true, value: int(42) });
  });
});
