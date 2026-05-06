export type { Expr, Module } from "./types.ts";
export { typecheck, buildTypeInfo } from "./typecheck.ts";
export type { TypeInfo } from "./typecheck.ts";
export { evaluate } from "./evaluate.ts";
export {
  evaluateModule,
  evaluateModuleRaw,
  evaluateModuleAsync,
  typecheckModule,
} from "./module.ts";
export { typecheckModuleRaw } from "./typecheck.ts";
export type {
  ModuleResolver,
  EvaluateModuleOptions,
  EvaluateModuleAsyncOptions,
  TypecheckModuleOptions,
} from "./module.ts";
export {
  compile,
  compileOptimized,
  compileToSource,
  compileEffectful,
  CompileError,
} from "./jit.ts";
export type { JitFn, JitEffectfulFn, CompileOptions } from "./jit.ts";
export { optimize, CONSTANT_FOLDING_RULES } from "./optimizer.ts";
export type { RewriteRule } from "./optimizer.ts";
export { compileReactive } from "./reactive.ts";
export type { ReactiveEnv, ReactiveSignal, ReactiveFn } from "./reactive.ts";
export { freeVariables } from "./free-vars.ts";
export {
  protocolResolver,
  mapResolver,
  cacheResolver,
  composeResolvers,
  libStdResolver,
  asyncProtocolResolver,
  cacheAsyncResolver,
  composeAsyncResolvers,
  httpResolver,
} from "./resolvers.ts";
export type { Resolver, AsyncResolver, MaybePromise } from "./resolvers.ts";

/**
 * Convenience resolver presets for common environments.
 *
 * - `browserResolver` — sync, lib:std only. For bundled apps with compile-time
 *   known modules. Compose with `mapResolver()` to add more.
 * - `networkResolverAsync` — async, lib:std + https:/http: fetch. For dynamic module
 *   loading. Use with `evaluateModuleAsync()`.
 *
 * Node/Bun consumers: import from `./node-preset.ts` directly to get
 * `localResolver`, `nodeResolver`, and `nodeResolverAsync`. That file is
 * intentionally not re-exported here to prevent `node:fs` from being pulled
 * into browser bundles.
 */
export { browserResolver, networkResolverAsync } from "./presets.ts";
