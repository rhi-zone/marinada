import { describe, it, expect } from "bun:test";
import {
  protocolResolver,
  mapResolver,
  cacheResolver,
  composeResolvers,
  libStdResolver,
} from "./resolvers.ts";
import type { Resolver } from "./resolvers.ts";
import type { Module } from "./types.ts";

// --- Helpers ---

function makeModule(name: string): Module {
  return { main: null, exports: [name] };
}

// --- protocolResolver ---

describe("protocolResolver", () => {
  it("dispatches to the correct handler by scheme", () => {
    const libModule = makeModule("lib");
    const libResolver: Resolver = () => libModule;
    const resolver = protocolResolver({ lib: libResolver });
    expect(resolver("lib:std")).toBe(libModule);
  });

  it("passes the full path to the handler", () => {
    let receivedPath: string | undefined;
    const handler: Resolver = (path) => {
      receivedPath = path;
      return null;
    };
    const resolver = protocolResolver({ local: handler });
    resolver("local:./foo/bar");
    expect(receivedPath).toBe("local:./foo/bar");
  });

  it("returns null for an unregistered protocol", () => {
    const resolver = protocolResolver({ lib: () => null });
    expect(resolver("https://example.com/mod")).toBeNull();
  });

  it("returns null when path has no colon", () => {
    const resolver = protocolResolver({ lib: () => makeModule("x") });
    expect(resolver("nostd")).toBeNull();
  });

  it("calls different handlers for different schemes", () => {
    const modA = makeModule("a");
    const modB = makeModule("b");
    const resolver = protocolResolver({
      aa: () => modA,
      bb: () => modB,
    });
    expect(resolver("aa:something")).toBe(modA);
    expect(resolver("bb:something")).toBe(modB);
    expect(resolver("cc:something")).toBeNull();
  });
});

// --- mapResolver ---

describe("mapResolver", () => {
  it("returns the module for an exact path match", () => {
    const mod = makeModule("mylib");
    const resolver = mapResolver({ "lib:mylib": mod });
    expect(resolver("lib:mylib")).toBe(mod);
  });

  it("returns null for a non-matching path", () => {
    const resolver = mapResolver({ "lib:mylib": makeModule("mylib") });
    expect(resolver("lib:other")).toBeNull();
  });

  it("returns null for an empty map", () => {
    const resolver = mapResolver({});
    expect(resolver("lib:std")).toBeNull();
  });

  it("handles multiple entries", () => {
    const modA = makeModule("a");
    const modB = makeModule("b");
    const resolver = mapResolver({ "lib:a": modA, "lib:b": modB });
    expect(resolver("lib:a")).toBe(modA);
    expect(resolver("lib:b")).toBe(modB);
    expect(resolver("lib:c")).toBeNull();
  });
});

// --- cacheResolver ---

describe("cacheResolver", () => {
  it("calls the inner resolver only once per path", () => {
    let callCount = 0;
    const mod = makeModule("cached");
    const inner: Resolver = (path) => {
      if (path === "lib:once") {
        callCount++;
        return mod;
      }
      return null;
    };
    const resolver = cacheResolver(inner);
    const first = resolver("lib:once");
    const second = resolver("lib:once");
    expect(first).toBe(mod);
    expect(second).toBe(mod);
    expect(callCount).toBe(1);
  });

  it("caches null results — does not retry on null", () => {
    let callCount = 0;
    const inner: Resolver = (_path) => {
      callCount++;
      return null;
    };
    const resolver = cacheResolver(inner);
    resolver("lib:missing");
    resolver("lib:missing");
    expect(callCount).toBe(1);
  });

  it("caches independently per path", () => {
    let callCount = 0;
    const inner: Resolver = (path) => {
      callCount++;
      return makeModule(path);
    };
    const resolver = cacheResolver(inner);
    resolver("lib:a");
    resolver("lib:a");
    resolver("lib:b");
    resolver("lib:b");
    expect(callCount).toBe(2);
  });
});

// --- composeResolvers ---

describe("composeResolvers", () => {
  it("returns the first non-null result", () => {
    const modA = makeModule("a");
    const modB = makeModule("b");
    const resolver = composeResolvers(
      () => modA,
      () => modB,
    );
    expect(resolver("anything")).toBe(modA);
  });

  it("skips null results and returns the next non-null", () => {
    const modB = makeModule("b");
    const resolver = composeResolvers(
      () => null,
      () => modB,
    );
    expect(resolver("anything")).toBe(modB);
  });

  it("returns null if all resolvers return null", () => {
    const resolver = composeResolvers(
      () => null,
      () => null,
    );
    expect(resolver("anything")).toBeNull();
  });

  it("short-circuits on first match — does not call subsequent resolvers", () => {
    let secondCalled = false;
    const modA = makeModule("a");
    const resolver = composeResolvers(
      () => modA,
      (_path) => {
        secondCalled = true;
        return makeModule("b");
      },
    );
    resolver("anything");
    expect(secondCalled).toBe(false);
  });

  it("works with zero resolvers — returns null", () => {
    const resolver = composeResolvers();
    expect(resolver("lib:std")).toBeNull();
  });
});

// --- libStdResolver ---

describe("libStdResolver", () => {
  it("returns a Module for 'lib:std'", () => {
    const result = libStdResolver("lib:std");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
  });

  it("returns a Module with expected std exports including map, filter, reduce", () => {
    const result = libStdResolver("lib:std");
    expect(result).not.toBeNull();
    const exports = result!.exports ?? [];
    expect(exports).toContain("map");
    expect(exports).toContain("filter");
    expect(exports).toContain("reduce");
  });

  it("returns null for unknown paths", () => {
    expect(libStdResolver("lib:other")).toBeNull();
    expect(libStdResolver("local:./foo")).toBeNull();
    expect(libStdResolver("")).toBeNull();
  });
});

// --- Composition: protocolResolver + libStdResolver ---

describe("composition", () => {
  it("protocolResolver({ lib: libStdResolver }) resolves 'lib:std' correctly", () => {
    const resolver = protocolResolver({ lib: libStdResolver });
    const result = resolver("lib:std");
    expect(result).not.toBeNull();
    const exports = result!.exports ?? [];
    expect(exports).toContain("map");
    expect(exports).toContain("filter");
    expect(exports).toContain("reduce");
  });

  it("protocolResolver + composeResolvers chain works", () => {
    const modA = makeModule("a");
    const resolver = composeResolvers(
      protocolResolver({ lib: libStdResolver }),
      mapResolver({ "local:a": modA }),
    );
    const stdResult = resolver("lib:std");
    expect(stdResult).not.toBeNull();
    expect((stdResult!.exports ?? []).includes("map")).toBe(true);

    const localResult = resolver("local:a");
    expect(localResult).toBe(modA);

    expect(resolver("unknown:x")).toBeNull();
  });
});
