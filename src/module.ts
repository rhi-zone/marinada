import type { Expr, Module } from "./types.ts";
import { evaluate, EMPTY_ENV } from "./evaluate.ts";
import type { EvalResult } from "./evaluate.ts";
import type { Value } from "./value.ts";
import { NULL } from "./value.ts";
import { Env } from "./env.ts";
import { typecheckModule } from "./typecheck.ts";
import type { TypecheckResult } from "./typecheck.ts";
import { libStdResolver } from "./resolvers.ts";
import type { AsyncResolver, MaybePromise } from "./resolvers.ts";

export type { EvalResult, TypecheckResult };

/**
 * Resolves a module import path to its `Module` definition. Returns `null`
 * when the resolver cannot resolve the given path. The resolver is called
 * lazily during `evaluateModule` / `typecheckModule` and is responsible for
 * any caching, IO, or scheme handling (`local:`, `https:`, custom `lib:`...).
 */
export type ModuleResolver = (from: string) => Module | null;

export type EvaluateModuleOptions = {
  resolver?: ModuleResolver;
};

export type TypecheckModuleOptions = {
  resolver?: ModuleResolver;
};

// ---------------------------------------------------------------------------
// evaluateModule
// ---------------------------------------------------------------------------

/** Result of evaluating a resolved module: the main result plus its exports. */
type ModuleEvalExports = {
  result: EvalResult;
  exports: Map<string, Value>;
};

/**
 * Cache entry for an in-flight or completed module evaluation. The
 * "in-progress" status appears when a module is encountered again while it
 * is still being evaluated (i.e. an import cycle). `partialExports` is the
 * live map of exports that have been bound so far in the recursive call;
 * importing modules read from this map at evaluation time, so values bound
 * after the cycle is opened still become visible (works for closures that
 * capture the env lazily — fails for non-function values that are needed
 * before they're bound, which surfaces as `CIRCULAR_DEPENDENCY`).
 *
 * `deferred` is a list of patches: when an importer requests a name from
 * an in-progress module before it is bound, the importer installs a NULL
 * placeholder in its env and registers a patch here. Once the in-progress
 * module finishes (or partially binds the name), each patch's env is
 * mutated via `env.set(name, value)`. Closures captured before the patch
 * read the patched value through the shared Env reference at call time.
 */
type DeferredImportPatch = { env: Env; name: string };
type EvalCacheEntry =
  | { status: "in-progress"; partialExports: Map<string, Value>; deferred: DeferredImportPatch[] }
  | { status: "done"; result: ModuleEvalExports };

function evalErr(code: string, message: string): EvalResult {
  return { ok: false, error: { code, path: [], message } };
}

/**
 * Evaluate a module fully and extract values for each name listed in
 * `module.exports`. Uses let/letrec peeling on `module.main`: we walk the
 * outermost let/letrec layers, evaluating each binding in sequence and
 * recording values for names listed in `module.exports`. The final inner
 * body's result is returned as `result`.
 */
function evaluateModuleExports(
  module: Module,
  resolve: (path: string) => Module | null,
  cache: Map<string, EvalCacheEntry>,
  modCache: Map<Module, EvalCacheEntry>,
  exports: Map<string, Value>,
): ModuleEvalExports {
  // Register this module by identity as in-progress, so any transitive
  // import that resolves back to the same Module object reuses our
  // partialExports and deferred-patch list. The string cache is keyed by
  // import path; this module-identity cache catches the case where the
  // top-level (resolver-less) entry module is re-imported by name.
  const selfDeferred: DeferredImportPatch[] = [];
  const selfEntry: EvalCacheEntry = {
    status: "in-progress",
    partialExports: exports,
    deferred: selfDeferred,
  };
  modCache.set(module, selfEntry);
  // Helper: when a name is freshly bound in `exports` (this module's
  // partialExports), patch any deferred entries that were waiting on it.
  // This must run incrementally as bindings appear, not at the end of
  // module evaluation, because main may itself trigger calls (via cycles)
  // that read patched values before main returns.
  function patchDeferred(name: string, value: Value): void {
    for (let i = selfDeferred.length - 1; i >= 0; i--) {
      const p = selfDeferred[i] as DeferredImportPatch;
      if (p.name === name) {
        p.env.set(name, value);
        selfDeferred.splice(i, 1);
      }
    }
  }

  // Build the import env first.
  let env = EMPTY_ENV;
  for (const imp of module.imports ?? []) {
    let importExports: Map<string, Value>;
    const cached = cache.get(imp.from);
    if (cached === undefined) {
      const mod = resolve(imp.from);
      if (mod === null) {
        return {
          result: evalErr("MODULE_NOT_FOUND", `module not found: ${imp.from}`),
          exports,
        };
      }
      // If the resolved module reference is already known to us by
      // identity (e.g. a cycle back to the top-level module), reuse its
      // in-progress slot.
      const byId = modCache.get(mod);
      if (byId !== undefined && byId.status === "in-progress") {
        cache.set(imp.from, byId);
        importExports = byId.partialExports;
      } else {
        // Open an in-progress slot before recursing so a cycle back into
        // us (or a transitive cycle) detects this module as in-progress
        // and uses its partialExports map.
        const partialExports = new Map<string, Value>();
        const deferred: DeferredImportPatch[] = [];
        const slot: EvalCacheEntry = { status: "in-progress", partialExports, deferred };
        cache.set(imp.from, slot);
        const resolved = evaluateModuleExports(mod, resolve, cache, modCache, partialExports);
        // Apply any deferred patches now that the in-progress module is
        // complete and its partialExports are fully populated.
        for (const patch of deferred) {
          const v = partialExports.get(patch.name);
          if (v !== undefined) patch.env.set(patch.name, v);
        }
        cache.set(imp.from, { status: "done", result: resolved });
        if (!resolved.result.ok) return { result: resolved.result, exports };
        importExports = resolved.exports;
      }
    } else if (cached.status === "in-progress") {
      // Cycle: the in-progress module's partialExports is the live map of
      // values bound so far. Reading proceeds, but missing values surface as
      // CIRCULAR_DEPENDENCY (see below).
      importExports = cached.partialExports;
    } else {
      if (!cached.result.result.ok) return { result: cached.result.result, exports };
      importExports = cached.result.exports;
    }
    const importBindings: Record<string, Value> = {};
    const pendingNames: string[] = [];
    for (const name of imp.import) {
      if (!importExports.has(name)) {
        const cachedAgain = cache.get(imp.from);
        if (cachedAgain !== undefined && cachedAgain.status === "in-progress") {
          // Cycle: the value isn't bound yet. Install a NULL placeholder
          // and register a deferred patch that fires once the in-progress
          // module finishes binding the name. Closures captured before
          // the patch read the updated value via the shared Env.
          importBindings[name] = NULL;
          pendingNames.push(name);
          continue;
        }
        return {
          result: evalErr("UNDEFINED_EXPORT", `module ${imp.from} does not export "${name}"`),
          exports,
        };
      }
      importBindings[name] = importExports.get(name) as Value;
    }
    env = env.extend(importBindings);
    if (pendingNames.length > 0) {
      const cachedAgain = cache.get(imp.from);
      if (cachedAgain !== undefined && cachedAgain.status === "in-progress") {
        for (const name of pendingNames) {
          cachedAgain.deferred.push({ env, name });
        }
      }
    }
  }

  const exportSet = new Set(module.exports ?? []);

  // Peel let/letrec layers from module.main.
  let cur: Expr = module.main;
  let curEnv: Env = env;

  while (Array.isArray(cur) && cur.length === 3 && (cur[0] === "let" || cur[0] === "letrec")) {
    const head = cur[0];
    const bindings = cur[1];
    const body = cur[2] as Expr;
    if (!Array.isArray(bindings)) break;

    if (head === "let") {
      let stepEnv = curEnv;
      for (const binding of bindings) {
        if (!Array.isArray(binding) || binding.length !== 2) {
          // Malformed — fall back to evaluating the whole expr normally.
          return { result: evaluate(cur, curEnv), exports };
        }
        const name = binding[0];
        if (typeof name !== "string") {
          return { result: evaluate(cur, curEnv), exports };
        }
        const r = evaluate(binding[1] as Expr, stepEnv);
        if (!r.ok) return { result: r, exports };
        stepEnv = stepEnv.extend({ [name]: r.value });
        if (exportSet.has(name)) {
          exports.set(name, r.value);
          patchDeferred(name, r.value);
        }
      }
      curEnv = stepEnv;
    } else {
      // letrec — placeholder pass, then fill.
      const placeholders: Record<string, Value> = {};
      const names: string[] = [];
      for (const binding of bindings) {
        if (!Array.isArray(binding) || binding.length !== 2) {
          return { result: evaluate(cur, curEnv), exports };
        }
        const name = binding[0];
        if (typeof name !== "string") {
          return { result: evaluate(cur, curEnv), exports };
        }
        names.push(name);
        placeholders[name] = NULL;
      }
      const recEnv = curEnv.extend(placeholders);
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i] as Expr[];
        const r = evaluate(binding[1] as Expr, recEnv);
        if (!r.ok) return { result: r, exports };
        const name = names[i] as string;
        recEnv.set(name, r.value);
        if (exportSet.has(name)) {
          exports.set(name, r.value);
          patchDeferred(name, r.value);
        }
      }
      curEnv = recEnv;
    }
    cur = body;
  }

  const result = evaluate(cur, curEnv);
  // Apply deferred patches against this module's own slot (other modules
  // may have deferred imports against us during a cycle); the partial
  // exports are now complete.
  for (const patch of selfDeferred) {
    const v = exports.get(patch.name);
    if (v !== undefined) patch.env.set(patch.name, v);
  }
  modCache.set(module, { status: "done", result: { result, exports } });
  return { result, exports };
}

/** Shared post-evaluation check for unresolved deferred patches (cycles). */
function checkDeferredCycles(
  result: EvalResult,
  modCache: Map<Module, EvalCacheEntry>,
): EvalResult {
  if (!result.ok) {
    for (const entry of modCache.values()) {
      if (entry.status === "in-progress" && entry.deferred.length > 0) {
        const stuck = entry.deferred[0] as DeferredImportPatch;
        return {
          ok: false,
          error: {
            code: "CIRCULAR_DEPENDENCY",
            path: [],
            message: `circular dependency: "${stuck.name}" was imported during a cycle but never bound`,
          },
        };
      }
    }
  }
  return result;
}

/**
 * Evaluate a full module.
 *
 * All imports are resolved through the optional user-provided `resolver` first;
 * `defaultResolver` (which handles `lib:std`) is composed in as a fallback.
 * If neither can resolve an import, a `MODULE_NOT_FOUND` error is returned.
 *
 * Variant constructors (None, Some, Ok, Err, etc.) are handled automatically
 * by the evaluator's uppercase-tag convention — no env wiring required.
 */
export function evaluateModule(module: Module, opts?: EvaluateModuleOptions): EvalResult {
  // User resolver takes priority; defaultResolver (lib:std) is the fallback.
  const resolve = (path: string): Module | null =>
    opts?.resolver?.(path) ?? libStdResolver(path) ?? null;
  const cache = new Map<string, EvalCacheEntry>();
  const modCache = new Map<Module, EvalCacheEntry>();
  // After the evaluation completes, check whether any in-progress deferred
  // patches were left unresolved. An unresolved deferred patch means an
  // importer requested a name that was never bound by the time the cycle
  // target finished — a true circular dependency on a non-function value
  // (functions tolerate the deferral via env-set patching at bind time).
  return checkDeferredCycles(
    evaluateModuleExports(module, resolve, cache, modCache, new Map()).result,
    modCache,
  );
}

/**
 * Like `evaluateModule` but without `defaultResolver` composed in. If
 * `opts.resolver` returns `null` for a path, `MODULE_NOT_FOUND` is returned.
 * `lib:std` is NOT available unless the caller provides it via `opts.resolver`.
 * Use this variant when you want full control over which modules are loaded
 * (e.g. for tree-shaking or custom lib: schemes).
 */
export function evaluateModuleRaw(module: Module, opts?: EvaluateModuleOptions): EvalResult {
  const resolve = (path: string): Module | null => opts?.resolver?.(path) ?? null;
  const cache = new Map<string, EvalCacheEntry>();
  const modCache = new Map<Module, EvalCacheEntry>();
  return checkDeferredCycles(
    evaluateModuleExports(module, resolve, cache, modCache, new Map()).result,
    modCache,
  );
}

// Re-export typecheckModule so callers can import both from module.ts
export { typecheckModule };

// ---------------------------------------------------------------------------
// evaluateModuleAsync
// ---------------------------------------------------------------------------

export type EvaluateModuleAsyncOptions = {
  resolver?: AsyncResolver;
};

/**
 * Evaluate a full module, supporting async resolvers (resolvers that return
 * Promises). Every sync `Resolver` is also a valid `AsyncResolver`, so this
 * is a drop-in superset of `evaluateModule`.
 *
 * Cycle detection, deferred patches, and caching carry over identically from
 * `evaluateModule`. The difference is that each `resolve(path)` call is
 * awaited, enabling `https:` resolution and other async module loading.
 */
export async function evaluateModuleAsync(
  module: Module,
  opts?: EvaluateModuleAsyncOptions,
): Promise<EvalResult> {
  const resolve = (path: string): MaybePromise<Module | null> =>
    opts?.resolver?.(path) ?? libStdResolver(path) ?? null;
  const cache = new Map<string, EvalCacheEntry>();
  const modCache = new Map<Module, EvalCacheEntry>();
  return checkDeferredCycles(
    (await evaluateModuleExportsAsync(module, resolve, cache, modCache, new Map())).result,
    modCache,
  );
}

async function evaluateModuleExportsAsync(
  module: Module,
  resolve: (path: string) => MaybePromise<Module | null>,
  cache: Map<string, EvalCacheEntry>,
  modCache: Map<Module, EvalCacheEntry>,
  exports: Map<string, Value>,
): Promise<ModuleEvalExports> {
  const selfDeferred: DeferredImportPatch[] = [];
  const selfEntry: EvalCacheEntry = {
    status: "in-progress",
    partialExports: exports,
    deferred: selfDeferred,
  };
  modCache.set(module, selfEntry);

  function patchDeferred(name: string, value: Value): void {
    for (let i = selfDeferred.length - 1; i >= 0; i--) {
      const p = selfDeferred[i] as DeferredImportPatch;
      if (p.name === name) {
        p.env.set(name, value);
        selfDeferred.splice(i, 1);
      }
    }
  }

  let env = EMPTY_ENV;
  for (const imp of module.imports ?? []) {
    let importExports: Map<string, Value>;
    const cached = cache.get(imp.from);
    if (cached === undefined) {
      const mod = await resolve(imp.from);
      if (mod === null) {
        return {
          result: evalErr("MODULE_NOT_FOUND", `module not found: ${imp.from}`),
          exports,
        };
      }
      const byId = modCache.get(mod);
      if (byId !== undefined && byId.status === "in-progress") {
        cache.set(imp.from, byId);
        importExports = byId.partialExports;
      } else {
        const partialExports = new Map<string, Value>();
        const deferred: DeferredImportPatch[] = [];
        const slot: EvalCacheEntry = { status: "in-progress", partialExports, deferred };
        cache.set(imp.from, slot);
        const resolved = await evaluateModuleExportsAsync(
          mod,
          resolve,
          cache,
          modCache,
          partialExports,
        );
        for (const patch of deferred) {
          const v = partialExports.get(patch.name);
          if (v !== undefined) patch.env.set(patch.name, v);
        }
        cache.set(imp.from, { status: "done", result: resolved });
        if (!resolved.result.ok) return { result: resolved.result, exports };
        importExports = resolved.exports;
      }
    } else if (cached.status === "in-progress") {
      importExports = cached.partialExports;
    } else {
      if (!cached.result.result.ok) return { result: cached.result.result, exports };
      importExports = cached.result.exports;
    }
    const importBindings: Record<string, Value> = {};
    const pendingNames: string[] = [];
    for (const name of imp.import) {
      if (!importExports.has(name)) {
        const cachedAgain = cache.get(imp.from);
        if (cachedAgain !== undefined && cachedAgain.status === "in-progress") {
          importBindings[name] = NULL;
          pendingNames.push(name);
          continue;
        }
        return {
          result: evalErr("UNDEFINED_EXPORT", `module ${imp.from} does not export "${name}"`),
          exports,
        };
      }
      importBindings[name] = importExports.get(name) as Value;
    }
    env = env.extend(importBindings);
    if (pendingNames.length > 0) {
      const cachedAgain = cache.get(imp.from);
      if (cachedAgain !== undefined && cachedAgain.status === "in-progress") {
        for (const name of pendingNames) {
          cachedAgain.deferred.push({ env, name });
        }
      }
    }
  }

  const exportSet = new Set(module.exports ?? []);
  let cur: Expr = module.main;
  let curEnv: Env = env;

  while (Array.isArray(cur) && cur.length === 3 && (cur[0] === "let" || cur[0] === "letrec")) {
    const head = cur[0];
    const bindings = cur[1];
    const body = cur[2] as Expr;
    if (!Array.isArray(bindings)) break;

    if (head === "let") {
      let stepEnv = curEnv;
      for (const binding of bindings) {
        if (!Array.isArray(binding) || binding.length !== 2) {
          return { result: evaluate(cur, curEnv), exports };
        }
        const name = binding[0];
        if (typeof name !== "string") {
          return { result: evaluate(cur, curEnv), exports };
        }
        const r = evaluate(binding[1] as Expr, stepEnv);
        if (!r.ok) return { result: r, exports };
        stepEnv = stepEnv.extend({ [name]: r.value });
        if (exportSet.has(name)) {
          exports.set(name, r.value);
          patchDeferred(name, r.value);
        }
      }
      curEnv = stepEnv;
    } else {
      const placeholders: Record<string, Value> = {};
      const names: string[] = [];
      for (const binding of bindings) {
        if (!Array.isArray(binding) || binding.length !== 2) {
          return { result: evaluate(cur, curEnv), exports };
        }
        const name = binding[0];
        if (typeof name !== "string") {
          return { result: evaluate(cur, curEnv), exports };
        }
        names.push(name);
        placeholders[name] = NULL;
      }
      const recEnv = curEnv.extend(placeholders);
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i] as Expr[];
        const r = evaluate(binding[1] as Expr, recEnv);
        if (!r.ok) return { result: r, exports };
        const name = names[i] as string;
        recEnv.set(name, r.value);
        if (exportSet.has(name)) {
          exports.set(name, r.value);
          patchDeferred(name, r.value);
        }
      }
      curEnv = recEnv;
    }
    cur = body;
  }

  const result = evaluate(cur, curEnv);
  for (const patch of selfDeferred) {
    const v = exports.get(patch.name);
    if (v !== undefined) patch.env.set(patch.name, v);
  }
  modCache.set(module, { status: "done", result: { result, exports } });
  return { result, exports };
}
