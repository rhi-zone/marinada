import { computed, signal } from "@rhi-zone/rainbow";
import type { ReadonlySignal } from "@rhi-zone/rainbow";
import type { AsyncData } from "@rhi-zone/rainbow";
import { loading, success, failure } from "@rhi-zone/rainbow";
import type { Expr } from "./types.ts";
import type { Value } from "./value.ts";
import { NULL, bool } from "./value.ts";
import { Env, EMPTY_ENV } from "./env.ts";
import { evaluate, evalGen, callFnGen } from "./evaluate.ts";
import type { EvalGen } from "./evaluate.ts";
import { compile, compileEffectful as jitCompileEffectful } from "./jit.ts";
import { freeVariables } from "./free-vars.ts";

/**
 * Minimal reactive signal shape — only what compileReactive actually needs.
 * Structurally compatible with @rhi-zone/rainbow's Signal and ReadonlySignal,
 * and with @dusklight/core's Signal, without requiring the `map` method.
 */
export type ReactiveSignal<A = unknown> = {
  get(): A;
  subscribe(fn: (value: A) => void): () => void;
};

/**
 * An environment mapping variable names to reactive signals.
 * Each signal's current value is substituted when the expression evaluates.
 */
export type ReactiveEnv = Record<string, ReactiveSignal>;

/**
 * A compiled reactive expression: given a ReactiveEnv, returns a derived
 * signal that re-evaluates whenever any signal it reads changes.
 */
export type ReactiveFn = (env: ReactiveEnv) => ReadonlySignal<unknown>;

/**
 * Compile a Marinada expression to a reactive function.
 *
 * Pure expressions: the JIT compiles once; a Proxy env auto-tracks exactly
 * which signals are read on each evaluation (dynamic deps, Vue-style).
 *
 * Effectful expressions (perform/handle): the interpreter runs on each
 * re-evaluation with a snapshot of all env signals. Over-tracking is
 * intentional — free-variable analysis for precision is a future optimisation.
 */
export function compileReactive(expr: Expr): ReactiveFn {
  if (containsAsyncEffect(expr)) return compileAsync(expr);
  if (containsEffects(expr)) return compileEffectful(expr);
  const jitFn = compile(expr);
  return (env: ReactiveEnv) =>
    computed(() => {
      const proxy = new Proxy({} as Record<string, unknown>, {
        get(_, key: string) {
          return env[key]?.get();
        },
      });
      return jitFn(proxy);
    });
}

// ---------------------------------------------------------------------------
// Effect detection
// ---------------------------------------------------------------------------

function containsEffects(expr: Expr): boolean {
  if (!Array.isArray(expr) || expr.length === 0) return false;
  const op = expr[0];
  if (op === "perform" || op === "handle") return true;
  return expr.slice(1).some((e) => containsEffects(e as Expr));
}

/**
 * Returns true if `expr` contains a `["perform", "Async", ...]` node anywhere
 * in the tree. Used to route expressions to the async reactive path.
 */
export function containsAsyncEffect(expr: Expr): boolean {
  if (!Array.isArray(expr) || expr.length === 0) return false;
  if (expr[0] === "perform" && expr[1] === "Async") return true;
  return expr.slice(1).some((e) => containsAsyncEffect(e as Expr));
}

// ---------------------------------------------------------------------------
// Effectful path — interpreter with snapshot env
// ---------------------------------------------------------------------------

function compileEffectful(expr: Expr): ReactiveFn {
  // Attempt JIT compilation. Falls back to interpreter if the expression
  // contains effects that the JIT can't handle (e.g. perform inside a fn body).
  let jitFn: ReturnType<typeof jitCompileEffectful> | null = null;
  try {
    jitFn = jitCompileEffectful(expr);
  } catch {
    // JIT failed — fall back to interpreter path below.
  }

  const freeVars = freeVariables(expr);

  if (jitFn !== null) {
    const capturedJitFn = jitFn;
    return (env: ReactiveEnv) =>
      computed(() => {
        // Only snapshot the signals for variables that are actually free in the
        // expression — precise dep tracking avoids spurious re-runs.
        const snapshot: Record<string, unknown> = {};
        for (const key of freeVars) {
          const sig = env[key];
          if (sig !== undefined) snapshot[key] = sig.get();
        }
        const gen = capturedJitFn(snapshot);
        let step = gen.next();
        while (!step.done) {
          throw new Error(`[UNHANDLED_EFFECT] ${(step.value as { tag: string }).tag}`);
        }
        return step.value;
      });
  }

  // Interpreter fallback for expressions the JIT cannot handle.
  return (env: ReactiveEnv) =>
    computed(() => {
      const snapshot: Record<string, Value> = {};
      for (const key of freeVars) {
        const sig = env[key];
        if (sig !== undefined) snapshot[key] = jsToValue(sig.get());
      }
      const interpEnv = EMPTY_ENV.extend(snapshot);
      const result = evaluate(expr, interpEnv);
      if (!result.ok) {
        throw new Error(`[${result.error.code}] ${result.error.message}`);
      }
      return valueToJs(result.value);
    });
}

// ---------------------------------------------------------------------------
// Async reactive path — AbortController-based cancellation
// ---------------------------------------------------------------------------

/**
 * Compile an expression containing `perform "Async"` to a reactive function
 * that returns a `ReadonlySignal<AsyncData<unknown>>`.
 *
 * When dependencies change:
 * 1. Previous in-flight AbortController is aborted.
 * 2. Signal updates to `loading`.
 * 3. A new evaluation starts with a fresh AbortController.
 * 4. On success: signal updates to `success(value)`.
 * 5. On rejection: signal updates to `failure(error)`.
 */
function compileAsync(expr: Expr): ReactiveFn {
  const freeVars = freeVariables(expr);
  return (env: ReactiveEnv): ReadonlySignal<unknown> => {
    const state = signal<AsyncData<unknown>>(loading);
    let controller: AbortController | null = null;

    // A computed signal over the free variables — changes when any dep changes.
    const depsSignal = computed(() => {
      const snap: Record<string, unknown> = {};
      for (const key of freeVars) snap[key] = env[key]?.get();
      return snap;
    });

    const run = (snapshot: Record<string, unknown>) => {
      // Cancel previous in-flight request.
      controller?.abort();
      controller = new AbortController();
      const abortSignal = controller.signal;
      state.set(loading);

      const interpEnv = EMPTY_ENV.extend(
        Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, jsToValue(v)])),
      );

      evaluateAsync(expr, interpEnv, abortSignal).then(
        (value) => {
          if (!abortSignal.aborted) state.set(success(value));
        },
        (err: unknown) => {
          if (!abortSignal.aborted) state.set(failure(err));
        },
      );
    };

    // Run immediately with current values, then subscribe to future changes.
    run(depsSignal.get());
    depsSignal.subscribe(run);

    return state;
  };
}

/**
 * Wrap a native JS AbortSignal as a Marinada `cap` value so it can be passed
 * to Marinada functions as an argument.
 */
function abortSignalToCap(abortSignal: AbortSignal): Value {
  return {
    kind: "cap",
    id: "AbortSignal",
    methods: {
      aborted: () => ({ ok: true as const, value: bool(abortSignal.aborted) }),
    },
  };
}

// Registry mapping unique cap ids to native async factories.
// Used by `makeAsyncFnCap` to bridge JS Promises into Marinada's value system.
const nativeAsyncRegistry = new Map<string, (signal: AbortSignal) => Promise<unknown>>();
let nativeAsyncIdCounter = 0;

/**
 * Wrap a native JS async factory as a Marinada `cap` value that can be used
 * as the payload of `perform "Async"`. The factory receives the AbortSignal
 * directly and returns a Promise.
 *
 * Use this in host code or tests to bridge native async operations into
 * Marinada expressions.
 *
 * @example
 * const fetchCap = makeAsyncFnCap((signal) => fetch("/api", { signal }).then(r => r.json()))
 * const expr: Expr = ["perform", "Async", fetchCap]
 */
export function makeAsyncFnCap(factory: (signal: AbortSignal) => Promise<unknown>): Value {
  const id = "__asyncFn_" + String(nativeAsyncIdCounter++);
  nativeAsyncRegistry.set(id, factory);
  return {
    kind: "cap",
    id,
    methods: {},
  };
}

/**
 * Call a Marinada fn value (or native async cap) with the AbortSignal and
 * return a Promise resolving to the raw JS result.
 *
 * - If `fnVal` is a `cap` registered via `makeAsyncFnCap`, calls the native
 *   factory directly with the AbortSignal.
 * - If `fnVal` is a Marinada `fn`, wraps the signal as a cap, calls the body
 *   synchronously via `evalGen`, and resolves with `valueToJs(result)`.
 */
function callAsyncFn(fnVal: Value, abortSignal: AbortSignal): Promise<unknown> {
  if (fnVal.kind === "cap") {
    const factory = nativeAsyncRegistry.get(fnVal.id);
    if (factory !== undefined) {
      return factory(abortSignal);
    }
    return Promise.reject(new Error("cap is not a registered async fn cap: " + fnVal.id));
  }

  if (fnVal.kind !== "fn") {
    return Promise.reject(new Error("Async payload must be a fn or cap, got " + fnVal.kind));
  }

  const signalCap = abortSignalToCap(abortSignal);
  const gen = callFnGen(fnVal, [signalCap], []);
  let step = gen.next();
  // Step through synchronously; Async effects inside the fn body are not
  // supported at this level (they would need a recursive async evaluation).
  while (!step.done) {
    const effect = step.value;
    // Propagate unhandled inner effects as rejections.
    return Promise.reject(new Error("UNHANDLED_EFFECT: " + effect.tag));
  }
  const evalResult = step.value;
  if (!evalResult.ok) {
    return Promise.reject(new Error("[" + evalResult.error.code + "] " + evalResult.error.message));
  }
  return Promise.resolve(valueToJs(evalResult.value));
}

/**
 * Async interpreter: steps through `evalGen` manually, handling `Async`
 * effects by calling the payload fn with the AbortSignal and awaiting the
 * resulting Promise. All other effects are rejected as unhandled.
 */
async function evaluateAsync(expr: Expr, env: Env, abortSignal: AbortSignal): Promise<unknown> {
  const gen: EvalGen = evalGen(expr, env);
  let step = gen.next();
  while (!step.done) {
    const effect = step.value;
    if (effect.tag === "Async") {
      if (abortSignal.aborted) throw new Error("aborted");
      const fnVal = effect.payload;
      const result = await callAsyncFn(fnVal, abortSignal);
      if (abortSignal.aborted) throw new Error("aborted");
      step = gen.next(jsToValue(result));
    } else {
      throw new Error("UNHANDLED_EFFECT: " + effect.tag);
    }
  }
  const evalResult = step.value;
  if (!evalResult.ok) {
    throw new Error("[" + evalResult.error.code + "] " + evalResult.error.message);
  }
  return valueToJs(evalResult.value);
}

// ---------------------------------------------------------------------------
// JS ↔ Marinada Value conversion
// ---------------------------------------------------------------------------

function isMaranadaValue(v: unknown): v is Value {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as Record<string, unknown>)["kind"];
  return (
    kind === "null" ||
    kind === "bool" ||
    kind === "int" ||
    kind === "float" ||
    kind === "string" ||
    kind === "bytes" ||
    kind === "array" ||
    kind === "record" ||
    kind === "fn" ||
    kind === "variant" ||
    kind === "cap" ||
    kind === "continuation"
  );
}

function jsToValue(v: unknown): Value {
  if (v === null || v === undefined) return NULL;
  if (typeof v === "boolean") return bool(v);
  if (typeof v === "bigint") return { kind: "int", value: v };
  if (typeof v === "number") return { kind: "float", value: v };
  if (typeof v === "string") return { kind: "string", value: v };
  if (v instanceof Uint8Array) return { kind: "bytes", value: v };
  if (Array.isArray(v)) return { kind: "array", value: v.map(jsToValue) };
  if (typeof v === "object") {
    // Pass through Marinada Value objects directly — they don't need conversion.
    if (isMaranadaValue(v)) return v;
    return {
      kind: "record",
      value: new Map(
        Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, jsToValue(val)]),
      ),
    };
  }
  throw new Error(`jsToValue: cannot convert ${typeof v}`);
}

function valueToJs(v: Value): unknown {
  switch (v.kind) {
    case "null":
      return null;
    case "bool":
      return v.value;
    case "int":
      return v.value;
    case "float":
      return v.value;
    case "string":
      return v.value;
    case "bytes":
      return v.value;
    case "array":
      return v.value.map(valueToJs);
    case "record":
      return Object.fromEntries([...v.value.entries()].map(([k, val]) => [k, valueToJs(val)]));
    default:
      return v; // fn, variant, cap, continuation — pass through opaque
  }
}
