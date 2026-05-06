import { describe, it, expect } from "bun:test";
import { compile, compileEffectful, CompileError } from "./jit.ts";

describe("compileEffectful — Phase 1: perform", () => {
  it("compile() still throws CompileError for perform", () => {
    expect(() => compile(["perform", "IO", 0])).toThrow(CompileError);
  });

  it("perform with compileEffectful: generator yields the effect", () => {
    const fn = compileEffectful(["perform", "IO", 42]);
    const gen = fn({});
    const step = gen.next();
    expect(step.done).toBe(false);
    expect((step.value as any).tag).toBe("IO");
    expect((step.value as any).payload).toBe(42n); // Marinada int
  });

  it("pure expression in compileEffectful: generator returns value directly", () => {
    const fn = compileEffectful(["+", 3, 4]);
    const gen = fn({});
    const step = gen.next();
    expect(step.done).toBe(true);
    expect(step.value).toBe(7n);
  });

  it("perform with env variable as payload", () => {
    const fn = compileEffectful(["perform", "Tag", "x"]);
    const gen = fn({ x: 10n });
    const step = gen.next();
    expect(step.done).toBe(false);
    expect((step.value as any).tag).toBe("Tag");
    expect((step.value as any).payload).toBe(10n);
  });
});

describe("compileEffectful — Phase 2: handle", () => {
  it("basic: handler aborts with payload (no resume)", () => {
    const expr = [
      "handle",
      ["perform", "Greeting", 42],
      [["Greeting", "msg", "k"], "msg"],
      [["return", "x"], "x"],
    ];
    const fn = compileEffectful(expr);
    const gen = fn({});
    const step = gen.next();
    expect(step.done).toBe(true);
    expect(step.value).toBe(42n);
  });

  it("one-shot resume: handler calls k once", () => {
    const expr = [
      "handle",
      ["+", ["perform", "Double", "x"], 1],
      [
        ["Double", "v", "k"],
        ["call", "k", ["*", "v", 2]],
      ],
      [["return", "r"], "r"],
    ];
    const fn = compileEffectful(expr);
    // x=5 → Double(5) → k(10) → 10+1=11
    const gen = fn({ x: 5n });
    const step = gen.next();
    expect(step.done).toBe(true);
    expect(step.value).toBe(11n);
  });

  it("multi-shot: handler calls k twice (Yield/sum pattern)", () => {
    // Sum all yielded values via continuation
    const expr = [
      "handle",
      ["do", ["perform", "Yield", 1], ["perform", "Yield", 2], ["perform", "Yield", 3]],
      [
        ["Yield", "v", "k"],
        ["+", "v", ["call", "k", null]],
      ],
      [["return", "_"], 0],
    ];
    // 1 + (2 + (3 + 0)) = 6
    const fn = compileEffectful(expr);
    const gen = fn({});
    const step = gen.next();
    expect(step.done).toBe(true);
    expect(step.value).toBe(6n);
  });

  it("unhandled effect propagates outward", () => {
    const expr = [
      "handle",
      ["perform", "Unhandled", 0],
      [["Other", "v", "k"], "v"],
      [["return", "x"], "x"],
    ];
    const fn = compileEffectful(expr);
    const gen = fn({});
    const step = gen.next();
    expect(step.done).toBe(false); // effect propagated
    expect((step.value as any).tag).toBe("Unhandled");
  });

  it("nested handles", () => {
    const expr = [
      "handle",
      [
        "handle",
        ["perform", "Inner", 1],
        [
          ["Inner", "v", "k"],
          ["call", "k", ["+", "v", 10]],
        ],
        [["return", "x"], "x"],
      ],
      [["Outer", "v", "k"], "v"],
      [["return", "x"], "x"],
    ];
    const fn = compileEffectful(expr);
    const gen = fn({});
    const step = gen.next();
    expect(step.done).toBe(true);
    expect(step.value).toBe(11n);
  });
});
