import {
  protocolResolver,
  libStdResolver,
  asyncProtocolResolver,
  httpResolver,
  cacheAsyncResolver,
} from "./resolvers.ts";
import type { Resolver, AsyncResolver } from "./resolvers.ts";

/**
 * Browser preset — sync resolver for lib:std only.
 * Suitable for bundled apps where all modules are compile-time known.
 * Compose with mapResolver() to add additional bundled modules.
 */
export const browserResolver: Resolver = protocolResolver({
  lib: libStdResolver,
});

/**
 * Network preset — async resolver covering lib:std and https:/http: fetching.
 * Use with evaluateModuleAsync().
 * Suitable for dynamic module loading in browser or server environments.
 */
export const networkResolverAsync: AsyncResolver = asyncProtocolResolver({
  lib: libStdResolver,
  https: cacheAsyncResolver(httpResolver),
  http: cacheAsyncResolver(httpResolver),
});
