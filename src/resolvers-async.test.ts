import { describe, it, expect, mock } from "bun:test";
import {
  asyncProtocolResolver,
  cacheAsyncResolver,
  composeAsyncResolvers,
  httpResolver,
  mapResolver,
} from "./resolvers.ts";
import type { AsyncResolver } from "./resolvers.ts";
import type { Module } from "./types.ts";

// --- Helpers ---

function makeModule(name: string): Module {
  return { main: null, exports: [name] };
}

// --- asyncProtocolResolver ---

describe("asyncProtocolResolver", () => {
  it("dispatches to the correct handler by scheme (sync handler)", () => {
    const libModule = makeModule("lib");
    const resolver = asyncProtocolResolver({ lib: () => libModule });
    expect(resolver("lib:std")).toBe(libModule);
  });

  it("dispatches to the correct handler by scheme (async handler)", async () => {
    const libModule = makeModule("lib");
    const resolver = asyncProtocolResolver({ lib: async () => libModule });
    expect(await resolver("lib:std")).toBe(libModule);
  });

  it("passes the full path to the handler", async () => {
    let receivedPath: string | undefined;
    const resolver = asyncProtocolResolver({
      local: (path) => {
        receivedPath = path;
        return null;
      },
    });
    await resolver("local:./foo/bar");
    expect(receivedPath).toBe("local:./foo/bar");
  });

  it("returns null for an unregistered protocol", async () => {
    const resolver = asyncProtocolResolver({ lib: () => null });
    expect(await resolver("https://example.com/mod")).toBeNull();
  });

  it("returns null when path has no colon", async () => {
    const resolver = asyncProtocolResolver({ lib: () => makeModule("x") });
    expect(await resolver("noprotocol")).toBeNull();
  });

  it("handler can return a Promise that resolves to a module", async () => {
    const mod = makeModule("async-mod");
    const resolver = asyncProtocolResolver({
      remote: (_path) => Promise.resolve(mod),
    });
    expect(await resolver("remote:something")).toBe(mod);
  });
});

// --- cacheAsyncResolver ---

describe("cacheAsyncResolver", () => {
  it("calls the inner resolver only once per path", async () => {
    let callCount = 0;
    const mod = makeModule("cached");
    const inner: AsyncResolver = (path) => {
      if (path === "lib:once") {
        callCount++;
        return mod;
      }
      return null;
    };
    const resolver = cacheAsyncResolver(inner);
    const first = await resolver("lib:once");
    const second = await resolver("lib:once");
    expect(first).toBe(mod);
    expect(second).toBe(mod);
    expect(callCount).toBe(1);
  });

  it("caches null results — does not retry on null", async () => {
    let callCount = 0;
    const inner: AsyncResolver = (_path) => {
      callCount++;
      return null;
    };
    const resolver = cacheAsyncResolver(inner);
    await resolver("lib:missing");
    await resolver("lib:missing");
    expect(callCount).toBe(1);
  });

  it("concurrent calls for the same path share the same Promise", async () => {
    let callCount = 0;
    const mod = makeModule("shared");
    // Inner resolver returns a Promise that resolves after a microtask
    const inner: AsyncResolver = (_path) => {
      callCount++;
      return Promise.resolve(mod);
    };
    const resolver = cacheAsyncResolver(inner);
    // Fire two calls before awaiting either — they must share the same Promise
    const p1 = resolver("lib:shared");
    const p2 = resolver("lib:shared");
    expect(p1).toBe(p2); // same Promise reference
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(mod);
    expect(r2).toBe(mod);
    expect(callCount).toBe(1);
  });

  it("caches independently per path", async () => {
    let callCount = 0;
    const inner: AsyncResolver = (path) => {
      callCount++;
      return makeModule(path);
    };
    const resolver = cacheAsyncResolver(inner);
    await resolver("lib:a");
    await resolver("lib:a");
    await resolver("lib:b");
    await resolver("lib:b");
    expect(callCount).toBe(2);
  });
});

// --- composeAsyncResolvers ---

describe("composeAsyncResolvers", () => {
  it("returns the first non-null result (both sync)", async () => {
    const modA = makeModule("a");
    const modB = makeModule("b");
    const resolver = composeAsyncResolvers(
      () => modA,
      () => modB,
    );
    expect(await resolver("anything")).toBe(modA);
  });

  it("skips null results and returns the next non-null", async () => {
    const modB = makeModule("b");
    const resolver = composeAsyncResolvers(
      () => null,
      () => modB,
    );
    expect(await resolver("anything")).toBe(modB);
  });

  it("returns null if all resolvers return null", async () => {
    const resolver = composeAsyncResolvers(
      () => null,
      () => null,
    );
    expect(await resolver("anything")).toBeNull();
  });

  it("works with async resolvers returning Promises", async () => {
    const modB = makeModule("b");
    const resolver = composeAsyncResolvers(
      async () => null,
      async () => modB,
    );
    expect(await resolver("anything")).toBe(modB);
  });

  it("works with zero resolvers — returns null", async () => {
    const resolver = composeAsyncResolvers();
    expect(await resolver("lib:std")).toBeNull();
  });
});

// --- httpResolver ---

describe("httpResolver", () => {
  it("returns null for non-http/https paths", async () => {
    expect(await httpResolver("lib:std")).toBeNull();
    expect(await httpResolver("local:./foo")).toBeNull();
    expect(await httpResolver("ftp://example.com")).toBeNull();
  });

  it("composes with mapResolver via composeAsyncResolvers (standing in for network)", async () => {
    const mod = makeModule("remote-mod");
    mod.main = ["+", 1, 2];
    // Use a mapResolver as a stand-in for the network
    const fakeNetwork = mapResolver({ "https://example.com/mod.json": mod });
    const resolver = composeAsyncResolvers(fakeNetwork, httpResolver);
    const result = await resolver("https://example.com/mod.json");
    expect(result).toBe(mod);
  });

  it("composition falls through to httpResolver when mapResolver returns null", async () => {
    // We don't make real HTTP calls — just verify the composition returns null
    // when no resolver can handle the path (httpResolver would fail on real fetch too).
    const fakeNetwork = mapResolver({});
    // Override global fetch to return a 404
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request) => {
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const resolver = composeAsyncResolvers(fakeNetwork, httpResolver);
      const result = await resolver("https://example.com/missing.json");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns null when fetch response body is not a valid Module", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request) => {
      return new Response(JSON.stringify({ notMain: true }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await httpResolver("https://example.com/bad.json");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns a Module when fetch succeeds and body has a main field", async () => {
    const mod: Module = { main: null };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request) => {
      return new Response(JSON.stringify(mod), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await httpResolver("https://example.com/mod.json");
      expect(result).not.toBeNull();
      expect(result).toMatchObject({ main: null });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns null when fetch throws", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request) => {
      throw new Error("network error");
    }) as unknown as typeof fetch;
    try {
      const result = await httpResolver("https://example.com/error.json");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
