// Node/Bun only — imports 'node:fs' and 'node:path'
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  protocolResolver,
  asyncProtocolResolver,
  libStdResolver,
  cacheAsyncResolver,
  httpResolver,
} from "./resolvers.ts";
import type { Module } from "./types.ts";
import type { Resolver, AsyncResolver } from "./resolvers.ts";

/**
 * Create a local: resolver that reads Marinada modules from the filesystem.
 * Paths are resolved relative to `baseDir`.
 * "local:./foo.json" → reads `<baseDir>/foo.json`, parses as Module JSON.
 */
export function localResolver(baseDir: string): Resolver {
  return (path: string) => {
    if (!path.startsWith("local:")) return null;
    const rel = path.slice("local:".length);
    try {
      const abs = resolve(join(baseDir, rel));
      const text = readFileSync(abs, "utf8");
      const mod = JSON.parse(text) as Module;
      if (typeof mod !== "object" || mod === null || !("main" in mod)) return null;
      return mod;
    } catch {
      return null;
    }
  };
}

/**
 * Node sync preset — lib:std + local filesystem resolution.
 * Use with evaluateModule().
 */
export function nodeResolver(baseDir: string): Resolver {
  return protocolResolver({
    lib: libStdResolver,
    local: localResolver(baseDir),
  });
}

/**
 * Node async preset — lib:std + local filesystem + https: fetching.
 * Use with evaluateModuleAsync().
 */
export function nodeResolverAsync(baseDir: string): AsyncResolver {
  return asyncProtocolResolver({
    lib: libStdResolver,
    local: localResolver(baseDir),
    https: cacheAsyncResolver(httpResolver),
    http: cacheAsyncResolver(httpResolver),
  });
}
