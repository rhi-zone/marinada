import type { Expr } from "./types.ts";
import { Env, EMPTY_ENV } from "./env.ts";
import { type Value, NULL, bool, valEqual, typeName, valueToString } from "./value.ts";

export type EvalError = {
  code: string;
  path: number[];
  message: string;
};

export type EvalResult = { ok: true; value: Value } | { ok: false; error: EvalError };

export type Effect = { tag: string; payload: Value };

// --- Result helpers ---

function ok(value: Value): EvalResult {
  return { ok: true, value };
}

function err(code: string, path: number[], message: string): EvalResult {
  return { ok: false, error: { code, path, message } };
}

function prependPath(result: EvalResult, idx: number): EvalResult {
  if (result.ok) return result;
  return { ok: false, error: { ...result.error, path: [idx, ...result.error.path] } };
}

// Safe array access — callers guarantee index is in bounds after length checks.
// Using `as Expr` cast instead of `!` to satisfy no-non-null-assertion rule.
function at(arr: Expr[], i: number): Expr {
  return arr[i] as Expr;
}

// --- Type guards ---

function isInt(v: Value): v is { kind: "int"; value: bigint } {
  return v.kind === "int";
}

function isNumeric(
  v: Value,
): v is { kind: "int"; value: bigint } | { kind: "float"; value: number } {
  return v.kind === "int" || v.kind === "float";
}

// Convert int to float for mixed arithmetic
function toFloat(v: { kind: "int"; value: bigint } | { kind: "float"; value: number }): number {
  if (v.kind === "float") return v.value;
  return Number(v.value);
}

// --- Arithmetic helpers ---

type ArithOp = "+" | "-" | "*" | "/" | "%";

function applyArith(op: ArithOp, a: Value, b: Value, path: number[]): EvalResult {
  if (!isNumeric(a)) {
    return err(
      "TYPE_ERROR",
      path,
      "arithmetic requires number, got " + typeName(a) + " for left operand",
    );
  }
  if (!isNumeric(b)) {
    return err(
      "TYPE_ERROR",
      path,
      "arithmetic requires number, got " + typeName(b) + " for right operand",
    );
  }

  // int op int = int; anything with float = float
  if (isInt(a) && isInt(b)) {
    const av = a.value;
    const bv = b.value;
    switch (op) {
      case "+":
        return ok({ kind: "int", value: av + bv });
      case "-":
        return ok({ kind: "int", value: av - bv });
      case "*":
        return ok({ kind: "int", value: av * bv });
      case "/":
        if (bv === 0n) return err("DIVISION_BY_ZERO", path, "integer division by zero");
        return ok({ kind: "int", value: av / bv });
      case "%":
        if (bv === 0n) return err("DIVISION_BY_ZERO", path, "integer modulo by zero");
        return ok({ kind: "int", value: av % bv });
    }
  } else {
    const av = toFloat(a);
    const bv = toFloat(b);
    switch (op) {
      case "+":
        return ok({ kind: "float", value: av + bv });
      case "-":
        return ok({ kind: "float", value: av - bv });
      case "*":
        return ok({ kind: "float", value: av * bv });
      case "/":
        return ok({ kind: "float", value: av / bv });
      case "%":
        return ok({ kind: "float", value: av % bv });
    }
  }
}

// --- Comparison helpers ---

type CmpOp = "<" | ">" | "<=" | ">=";

function applyNumericCmp(op: CmpOp, a: Value, b: Value, path: number[]): EvalResult {
  if (!isNumeric(a)) {
    return err("TYPE_ERROR", path, "comparison requires number, got " + typeName(a));
  }
  if (!isNumeric(b)) {
    return err("TYPE_ERROR", path, "comparison requires number, got " + typeName(b));
  }
  // Promote to float for mixed comparison to keep things consistent
  const av = toFloat(a);
  const bv = toFloat(b);
  switch (op) {
    case "<":
      return ok(bool(av < bv));
    case ">":
      return ok(bool(av > bv));
    case "<=":
      return ok(bool(av <= bv));
    case ">=":
      return ok(bool(av >= bv));
  }
}

// --- get / set helpers ---

function getIn(obj: Value, path: Value[], pathPrefix: number[]): EvalResult {
  let current = obj;
  for (let i = 0; i < path.length; i++) {
    const key = path[i] as Value;
    const result = getField(current, key, [...pathPrefix, i]);
    if (!result.ok) return result;
    current = result.value;
  }
  return ok(current);
}

function getField(obj: Value, key: Value, errPath: number[]): EvalResult {
  if (obj.kind === "record") {
    if (key.kind !== "string") {
      return err("TYPE_ERROR", errPath, "record key must be string, got " + typeName(key));
    }
    const val = obj.value.get(key.value);
    if (val === undefined) {
      return ok(NULL);
    }
    return ok(val);
  } else if (obj.kind === "array") {
    if (key.kind !== "int") {
      return err("TYPE_ERROR", errPath, "array index must be int, got " + typeName(key));
    }
    const idx = Number(key.value);
    if (idx < 0 || idx >= obj.value.length) {
      return ok(NULL);
    }
    return ok(obj.value[idx] as Value);
  } else {
    return err("TYPE_ERROR", errPath, "get requires record or array, got " + typeName(obj));
  }
}

function setField(obj: Value, key: Value, val: Value, errPath: number[]): EvalResult {
  if (obj.kind === "record") {
    if (key.kind !== "string") {
      return err("TYPE_ERROR", errPath, "record key must be string, got " + typeName(key));
    }
    const newMap = new Map(obj.value);
    newMap.set(key.value, val);
    return ok({ kind: "record", value: newMap });
  } else if (obj.kind === "array") {
    if (key.kind !== "int") {
      return err("TYPE_ERROR", errPath, "array index must be int, got " + typeName(key));
    }
    const idx = Number(key.value);
    if (idx < 0 || idx > obj.value.length) {
      return err(
        "TYPE_ERROR",
        errPath,
        "array index " + String(idx) + " out of bounds (length " + String(obj.value.length) + ")",
      );
    }
    const newArr = [...obj.value];
    newArr[idx] = val;
    return ok({ kind: "array", value: newArr });
  } else {
    return err("TYPE_ERROR", errPath, "set requires record or array, got " + typeName(obj));
  }
}

function setIn(obj: Value, path: Value[], val: Value, pathPrefix: number[]): EvalResult {
  if (path.length === 0) return ok(val);
  const key = path[0] as Value;
  // Get current child
  const childResult = getField(obj, key, pathPrefix);
  if (!childResult.ok) return childResult;
  // Recurse
  const newChildResult = setIn(childResult.value, path.slice(1), val, [...pathPrefix, 0]);
  if (!newChildResult.ok) return newChildResult;
  return setField(obj, key, newChildResult.value, pathPrefix);
}

// --- Generator type alias ---

export type EvalGen = Generator<Effect, EvalResult, Value>;

// --- Call a fn or continuation value (generator version) ---

export function* callFnGen(fn: Value, args: Value[], callPath: number[]): EvalGen {
  if (fn.kind === "continuation") {
    if (args.length !== 1) {
      return err("ARITY_ERROR", callPath, "continuation expects 1 arg, got " + String(args.length));
    }
    return yield* fn.resume(args[0] as Value);
  }
  if (fn.kind !== "fn") {
    return err("TYPE_ERROR", callPath, "call requires fn, got " + typeName(fn));
  }
  if (args.length !== fn.params.length) {
    return err(
      "ARITY_ERROR",
      callPath,
      "fn expects " + String(fn.params.length) + " args, got " + String(args.length),
    );
  }
  const bindings: Record<string, Value> = {};
  for (let i = 0; i < fn.params.length; i++) {
    bindings[fn.params[i] as string] = args[i] as Value;
  }
  return yield* evalGen(fn.body, fn.env.extend(bindings));
}

// --- isVariantTag: string starting with uppercase ---

function isUpperCase(s: string): boolean {
  return s.length > 0 && (s[0] as string) >= "A" && (s[0] as string) <= "Z";
}

// --- Handler dispatch ---

// Parsed handler clause: either an effect clause or the return clause.
type EffectClause = {
  kind: "effect";
  tag: string;
  payloadBinding: string;
  kBinding: string;
  body: Expr;
};
type ReturnClause = {
  kind: "return";
  binding: string;
  body: Expr;
};

function* dispatchHandler(
  innerGen: EvalGen,
  step: IteratorResult<Effect, EvalResult>,
  effectClauses: EffectClause[],
  returnClause: ReturnClause | null,
  env: Env,
): EvalGen {
  while (!step.done) {
    const effect = step.value;
    const clause = effectClauses.find((c) => c.tag === effect.tag);
    if (clause) {
      // Build continuation: calling it resumes innerGen from its current suspension point
      const k: Value = {
        kind: "continuation",
        resume: (resumeVal: Value) =>
          dispatchHandler(innerGen, innerGen.next(resumeVal), effectClauses, returnClause, env),
      };
      const bindEnv = env.extend({ [clause.payloadBinding]: effect.payload, [clause.kBinding]: k });
      return yield* evalGen(clause.body, bindEnv);
    } else {
      // Propagate unhandled effect outward; receive the resume value from the outer handler
      const resumeVal: Value = yield effect;
      step = innerGen.next(resumeVal);
    }
  }
  // Inner computation completed
  const finalResult = step.value;
  if (!finalResult.ok) return finalResult;
  if (returnClause) {
    const bindEnv = env.extend({ [returnClause.binding]: finalResult.value });
    return yield* evalGen(returnClause.body, bindEnv);
  }
  return finalResult;
}

// --- Main evaluator (generator) ---

export function* evalGen(expr: Expr, env: Env): EvalGen {
  // Atoms
  if (expr === null) return ok(NULL);
  if (typeof expr === "boolean") return ok(bool(expr));
  if (typeof expr === "number") {
    if (Number.isInteger(expr)) {
      return ok({ kind: "int", value: BigInt(expr) });
    } else {
      return ok({ kind: "float", value: expr });
    }
  }
  if (typeof expr === "string") {
    // Bare strings are variable references
    const val = env.lookup(expr);
    if (val === undefined) {
      return err("UNDEFINED_VAR", [], "undefined variable: " + expr);
    }
    return ok(val);
  }

  // Non-array object: an opaque Marinada Value embedded directly in the Expr
  // tree (e.g. a cap or fn value injected by the host). Return it as-is.
  if (!Array.isArray(expr)) {
    return ok(expr as unknown as Value);
  }

  // Array = call
  const arr = expr;
  if (arr.length === 0) {
    return err("UNKNOWN_OP", [], "empty expression array");
  }

  const opExpr = arr[0];
  if (typeof opExpr !== "string") {
    return err("UNKNOWN_OP", [], "first element of call must be an op name (string)");
  }
  const op = opExpr;

  // --- Variant constructor: uppercase tag ---
  if (isUpperCase(op)) {
    const fields: Value[] = [];
    for (let i = 1; i < arr.length; i++) {
      const r = yield* evalGen(at(arr, i), env);
      const rp = prependPath(r, i);
      if (!rp.ok) return rp;
      fields.push(rp.value);
    }
    return ok({ kind: "variant", tag: op, fields });
  }

  switch (op) {
    // --- Data access ---
    case "get": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "get requires 2 args, got " + String(arr.length - 1));
      const objR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!objR.ok) return objR;
      const keyR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!keyR.ok) return keyR;
      return getField(objR.value, keyR.value, [2]);
    }

    case "get-in": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "get-in requires 2 args, got " + String(arr.length - 1));
      const objR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!objR.ok) return objR;
      const pathR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!pathR.ok) return pathR;
      if (pathR.value.kind !== "array") {
        return err("TYPE_ERROR", [2], "get-in path must be array, got " + typeName(pathR.value));
      }
      return getIn(objR.value, pathR.value.value, [1]);
    }

    case "set": {
      if (arr.length !== 4)
        return err("ARITY_ERROR", [], "set requires 3 args, got " + String(arr.length - 1));
      const objR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!objR.ok) return objR;
      const keyR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!keyR.ok) return keyR;
      const valR = prependPath(yield* evalGen(at(arr, 3), env), 3);
      if (!valR.ok) return valR;
      return setField(objR.value, keyR.value, valR.value, [2]);
    }

    case "set-in": {
      if (arr.length !== 4)
        return err("ARITY_ERROR", [], "set-in requires 3 args, got " + String(arr.length - 1));
      const objR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!objR.ok) return objR;
      const pathR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!pathR.ok) return pathR;
      if (pathR.value.kind !== "array") {
        return err("TYPE_ERROR", [2], "set-in path must be array, got " + typeName(pathR.value));
      }
      const valR = prependPath(yield* evalGen(at(arr, 3), env), 3);
      if (!valR.ok) return valR;
      return setIn(objR.value, pathR.value.value, valR.value, [1]);
    }

    // --- Arithmetic ---
    case "+":
    case "-":
    case "*":
    case "/":
    case "%": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], op + " requires 2 args, got " + String(arr.length - 1));
      const ar = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      const br = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!br.ok) return br;
      return applyArith(op, ar.value, br.value, []);
    }

    // --- Comparison ---
    case "==": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "== requires 2 args");
      const ar = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      const br = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!br.ok) return br;
      return ok(bool(valEqual(ar.value, br.value)));
    }

    case "!=": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "!= requires 2 args");
      const ar = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      const br = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!br.ok) return br;
      return ok(bool(!valEqual(ar.value, br.value)));
    }

    case "<":
    case ">":
    case "<=":
    case ">=": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], op + " requires 2 args");
      const ar = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      const br = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!br.ok) return br;
      return applyNumericCmp(op, ar.value, br.value, []);
    }

    // --- Logic ---
    case "and": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "and requires 2 args");
      const ar = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      if (ar.value.kind !== "bool") {
        return err("TYPE_ERROR", [1], "and requires bool, got " + typeName(ar.value));
      }
      const br = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!br.ok) return br;
      if (br.value.kind !== "bool") {
        return err("TYPE_ERROR", [2], "and requires bool, got " + typeName(br.value));
      }
      return ok(bool(ar.value.value && br.value.value));
    }

    case "or": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "or requires 2 args");
      const ar = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      if (ar.value.kind !== "bool") {
        return err("TYPE_ERROR", [1], "or requires bool, got " + typeName(ar.value));
      }
      const br = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!br.ok) return br;
      if (br.value.kind !== "bool") {
        return err("TYPE_ERROR", [2], "or requires bool, got " + typeName(br.value));
      }
      return ok(bool(ar.value.value || br.value.value));
    }

    case "not": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "not requires 1 arg");
      const ar = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!ar.ok) return ar;
      if (ar.value.kind !== "bool") {
        return err("TYPE_ERROR", [1], "not requires bool, got " + typeName(ar.value));
      }
      return ok(bool(!ar.value.value));
    }

    // --- Control flow ---
    case "if": {
      if (arr.length !== 4) return err("ARITY_ERROR", [], "if requires 3 args (cond, then, else)");
      const condR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!condR.ok) return condR;
      if (condR.value.kind !== "bool") {
        return err("TYPE_ERROR", [1], "if condition must be bool, got " + typeName(condR.value));
      }
      if (condR.value.value) {
        return prependPath(yield* evalGen(at(arr, 2), env), 2);
      } else {
        return prependPath(yield* evalGen(at(arr, 3), env), 3);
      }
    }

    case "__lit": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "__lit requires exactly 1 arg");
      // Raw literal value — argument is not evaluated, returned as-is
      const v = arr[1];
      if (v === null) return ok(NULL);
      if (typeof v === "boolean") return ok(bool(v));
      if (typeof v === "number")
        return ok(
          Number.isInteger(v) ? { kind: "int", value: BigInt(v) } : { kind: "float", value: v },
        );
      if (typeof v === "string") return ok({ kind: "string", value: v });
      return ok(NULL);
    }

    case "do": {
      if (arr.length < 2) return err("ARITY_ERROR", [], "do requires at least 1 expr");
      let last: EvalResult = ok(NULL);
      for (let i = 1; i < arr.length; i++) {
        last = prependPath(yield* evalGen(at(arr, i), env), i);
        if (!last.ok) return last;
      }
      return last;
    }

    case "let": {
      // ["let", [[name, val], ...], expr]
      if (arr.length !== 3) return err("ARITY_ERROR", [], "let requires 2 args");
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        return err("TYPE_ERROR", [1], "let bindings must be an array");
      }
      let currentEnv = env;
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          return err("TYPE_ERROR", [1, i], "each let binding must be [name, expr]");
        }
        const name = binding[0];
        if (typeof name !== "string") {
          return err("TYPE_ERROR", [1, i, 0], "let binding name must be a string");
        }
        const valR = prependPath(yield* evalGen(binding[1] as Expr, currentEnv), i);
        if (!valR.ok) return valR;
        currentEnv = currentEnv.extend({ [name]: valR.value });
      }
      return prependPath(yield* evalGen(at(arr, 2), currentEnv), 2);
    }

    case "letrec": {
      // ["letrec", [[name, val], ...], expr]
      // All bindings are in scope for all values (supports mutual recursion)
      if (arr.length !== 3) return err("ARITY_ERROR", [], "letrec requires 2 args");
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        return err("TYPE_ERROR", [1], "letrec bindings must be an array");
      }
      // Create a frame with placeholder nulls, then fill in
      const placeholders: Record<string, Value> = {};
      const names: string[] = [];
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          return err("TYPE_ERROR", [1, i], "each letrec binding must be [name, expr]");
        }
        const name = binding[0];
        if (typeof name !== "string") {
          return err("TYPE_ERROR", [1, i, 0], "letrec binding name must be a string");
        }
        names.push(name);
        placeholders[name] = NULL;
      }
      const recEnv = env.extend(placeholders);
      // Now evaluate each binding in the recursive env and mutate the frame
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i] as Expr[];
        const valR = prependPath(yield* evalGen(binding[1] as Expr, recEnv), i);
        if (!valR.ok) return valR;
        recEnv.set(names[i] as string, valR.value);
      }
      return prependPath(yield* evalGen(at(arr, 2), recEnv), 2);
    }

    // --- Type ops ---
    case "is": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "is requires 2 args");
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        return err("TYPE_ERROR", [1], "is requires a type name string as first arg");
      }
      const valR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!valR.ok) return valR;
      return ok(bool(checkType(valR.value, typStr)));
    }

    case "as": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "as requires 2 args");
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        return err("TYPE_ERROR", [1], "as requires a type name string as first arg");
      }
      const valR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!valR.ok) return valR;
      if (!checkType(valR.value, typStr)) {
        return err("TYPE_ERROR", [2], "expected " + typStr + ", got " + typeName(valR.value));
      }
      return valR;
    }

    case "untyped": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "untyped requires 1 arg");
      return prependPath(yield* evalGen(at(arr, 1), env), 1);
    }

    // --- Collections ---
    case "count": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "count requires 1 arg");
      const arrR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!arrR.ok) return arrR;
      if (arrR.value.kind === "array") {
        return ok({ kind: "int", value: BigInt(arrR.value.value.length) });
      } else if (arrR.value.kind === "record") {
        return ok({ kind: "int", value: BigInt(arrR.value.value.size) });
      } else {
        return err(
          "TYPE_ERROR",
          [1],
          "count requires array or record, got " + typeName(arrR.value),
        );
      }
    }

    case "merge": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "merge requires 2 args");
      const r1R = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!r1R.ok) return r1R;
      const r2R = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!r2R.ok) return r2R;
      if (r1R.value.kind !== "record") {
        return err("TYPE_ERROR", [1], "merge requires record, got " + typeName(r1R.value));
      }
      if (r2R.value.kind !== "record") {
        return err("TYPE_ERROR", [2], "merge requires record, got " + typeName(r2R.value));
      }
      const merged = new Map(r1R.value.value);
      for (const [k, v] of r2R.value.value) {
        merged.set(k, v);
      }
      return ok({ kind: "record", value: merged });
    }

    case "keys": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "keys requires 1 arg");
      const recR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!recR.ok) return recR;
      if (recR.value.kind !== "record") {
        return err("TYPE_ERROR", [1], "keys requires record, got " + typeName(recR.value));
      }
      const keys: Value[] = [...recR.value.value.keys()].map((k) => ({
        kind: "string" as const,
        value: k,
      }));
      return ok({ kind: "array", value: keys });
    }

    case "vals": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "vals requires 1 arg");
      const recR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!recR.ok) return recR;
      if (recR.value.kind !== "record") {
        return err("TYPE_ERROR", [1], "vals requires record, got " + typeName(recR.value));
      }
      return ok({ kind: "array", value: [...recR.value.value.values()] });
    }

    // --- Array primitives ---
    case "array": {
      const items: Value[] = [];
      for (let i = 1; i < arr.length; i++) {
        const r = prependPath(yield* evalGen(at(arr, i), env), i);
        if (!r.ok) return r;
        items.push(r.value);
      }
      return ok({ kind: "array", value: items });
    }

    case "array-get": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "array-get requires 2 args, got " + String(arr.length - 1));
      const agArrR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!agArrR.ok) return agArrR;
      if (agArrR.value.kind !== "array")
        return err("TYPE_ERROR", [1], "array-get requires array, got " + typeName(agArrR.value));
      const agIdxR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!agIdxR.ok) return agIdxR;
      if (!isInt(agIdxR.value))
        return err("TYPE_ERROR", [2], "array-get index must be int, got " + typeName(agIdxR.value));
      const agIdx = Number(agIdxR.value.value);
      if (agIdx < 0 || agIdx >= agArrR.value.value.length) return ok(NULL);
      return ok(agArrR.value.value[agIdx] as Value);
    }

    case "array-push": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "array-push requires 2 args, got " + String(arr.length - 1));
      const apArrR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!apArrR.ok) return apArrR;
      if (apArrR.value.kind !== "array")
        return err("TYPE_ERROR", [1], "array-push requires array, got " + typeName(apArrR.value));
      const apElemR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!apElemR.ok) return apElemR;
      return ok({ kind: "array", value: [...apArrR.value.value, apElemR.value] });
    }

    case "array-slice": {
      if (arr.length !== 4 && arr.length !== 3)
        return err(
          "ARITY_ERROR",
          [],
          "array-slice requires 2 or 3 args, got " + String(arr.length - 1),
        );
      const asArrR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!asArrR.ok) return asArrR;
      if (asArrR.value.kind !== "array")
        return err("TYPE_ERROR", [1], "array-slice requires array, got " + typeName(asArrR.value));
      const asStartR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!asStartR.ok) return asStartR;
      if (!isInt(asStartR.value))
        return err(
          "TYPE_ERROR",
          [2],
          "array-slice start must be int, got " + typeName(asStartR.value),
        );
      const asStart = Number(asStartR.value.value);
      if (arr.length === 3) {
        return ok({ kind: "array", value: asArrR.value.value.slice(asStart) });
      }
      const asEndR = prependPath(yield* evalGen(at(arr, 3), env), 3);
      if (!asEndR.ok) return asEndR;
      if (!isInt(asEndR.value))
        return err("TYPE_ERROR", [3], "array-slice end must be int, got " + typeName(asEndR.value));
      const asEnd = Number(asEndR.value.value);
      return ok({ kind: "array", value: asArrR.value.value.slice(asStart, asEnd) });
    }

    // --- Record aliases ---
    case "record-get": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "record-get requires 2 args, got " + String(arr.length - 1));
      const rgObjR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!rgObjR.ok) return rgObjR;
      const rgKeyR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!rgKeyR.ok) return rgKeyR;
      return getField(rgObjR.value, rgKeyR.value, [2]);
    }

    case "record-set": {
      if (arr.length !== 4)
        return err("ARITY_ERROR", [], "record-set requires 3 args, got " + String(arr.length - 1));
      const rsObjR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!rsObjR.ok) return rsObjR;
      const rsKeyR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!rsKeyR.ok) return rsKeyR;
      const rsValR = prependPath(yield* evalGen(at(arr, 3), env), 3);
      if (!rsValR.ok) return rsValR;
      return setField(rsObjR.value, rsKeyR.value, rsValR.value, [2]);
    }

    case "record-del": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "record-del requires 2 args, got " + String(arr.length - 1));
      const rdRecR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!rdRecR.ok) return rdRecR;
      if (rdRecR.value.kind !== "record")
        return err("TYPE_ERROR", [1], "record-del requires record, got " + typeName(rdRecR.value));
      const rdKeyR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!rdKeyR.ok) return rdKeyR;
      if (rdKeyR.value.kind !== "string")
        return err(
          "TYPE_ERROR",
          [2],
          "record-del key must be string, got " + typeName(rdKeyR.value),
        );
      const rdNewMap = new Map(rdRecR.value.value);
      rdNewMap.delete(rdKeyR.value.value);
      return ok({ kind: "record", value: rdNewMap });
    }

    case "record-keys": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "record-keys requires 1 arg");
      const rkRecR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!rkRecR.ok) return rkRecR;
      if (rkRecR.value.kind !== "record")
        return err("TYPE_ERROR", [1], "record-keys requires record, got " + typeName(rkRecR.value));
      const rkKeys: Value[] = [...rkRecR.value.value.keys()].map((k) => ({
        kind: "string" as const,
        value: k,
      }));
      return ok({ kind: "array", value: rkKeys });
    }

    case "record-vals": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "record-vals requires 1 arg");
      const rvRecR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!rvRecR.ok) return rvRecR;
      if (rvRecR.value.kind !== "record")
        return err("TYPE_ERROR", [1], "record-vals requires record, got " + typeName(rvRecR.value));
      return ok({ kind: "array", value: [...rvRecR.value.value.values()] });
    }

    case "record-merge": {
      if (arr.length !== 3)
        return err(
          "ARITY_ERROR",
          [],
          "record-merge requires 2 args, got " + String(arr.length - 1),
        );
      const rm1R = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!rm1R.ok) return rm1R;
      const rm2R = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!rm2R.ok) return rm2R;
      if (rm1R.value.kind !== "record")
        return err("TYPE_ERROR", [1], "record-merge requires record, got " + typeName(rm1R.value));
      if (rm2R.value.kind !== "record")
        return err("TYPE_ERROR", [2], "record-merge requires record, got " + typeName(rm2R.value));
      const rmMerged = new Map(rm1R.value.value);
      for (const [k, v] of rm2R.value.value) {
        rmMerged.set(k, v);
      }
      return ok({ kind: "record", value: rmMerged });
    }

    // --- String primitives ---
    case "str-len": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "str-len requires 1 arg");
      const slR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!slR.ok) return slR;
      if (slR.value.kind !== "string")
        return err("TYPE_ERROR", [1], "str-len requires string, got " + typeName(slR.value));
      return ok({ kind: "int", value: BigInt(slR.value.value.length) });
    }

    case "str-get": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "str-get requires 2 args, got " + String(arr.length - 1));
      const sgStrR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!sgStrR.ok) return sgStrR;
      if (sgStrR.value.kind !== "string")
        return err("TYPE_ERROR", [1], "str-get requires string, got " + typeName(sgStrR.value));
      const sgIdxR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!sgIdxR.ok) return sgIdxR;
      if (!isInt(sgIdxR.value))
        return err("TYPE_ERROR", [2], "str-get index must be int, got " + typeName(sgIdxR.value));
      const sgCp = sgStrR.value.value.codePointAt(Number(sgIdxR.value.value));
      if (sgCp === undefined) return ok(NULL);
      return ok({ kind: "int", value: BigInt(sgCp) });
    }

    case "str-concat": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "str-concat requires 2 args, got " + String(arr.length - 1));
      const sc1R = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!sc1R.ok) return sc1R;
      if (sc1R.value.kind !== "string")
        return err("TYPE_ERROR", [1], "str-concat requires string, got " + typeName(sc1R.value));
      const sc2R = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!sc2R.ok) return sc2R;
      if (sc2R.value.kind !== "string")
        return err("TYPE_ERROR", [2], "str-concat requires string, got " + typeName(sc2R.value));
      return ok({ kind: "string", value: sc1R.value.value + sc2R.value.value });
    }

    case "str-slice": {
      if (arr.length !== 4)
        return err("ARITY_ERROR", [], "str-slice requires 3 args, got " + String(arr.length - 1));
      const ssStrR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!ssStrR.ok) return ssStrR;
      if (ssStrR.value.kind !== "string")
        return err("TYPE_ERROR", [1], "str-slice requires string, got " + typeName(ssStrR.value));
      const ssStartR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!ssStartR.ok) return ssStartR;
      if (!isInt(ssStartR.value))
        return err(
          "TYPE_ERROR",
          [2],
          "str-slice start must be int, got " + typeName(ssStartR.value),
        );
      const ssEndR = prependPath(yield* evalGen(at(arr, 3), env), 3);
      if (!ssEndR.ok) return ssEndR;
      if (!isInt(ssEndR.value))
        return err("TYPE_ERROR", [3], "str-slice end must be int, got " + typeName(ssEndR.value));
      return ok({
        kind: "string",
        value: ssStrR.value.value.slice(Number(ssStartR.value.value), Number(ssEndR.value.value)),
      });
    }

    case "str-cmp": {
      if (arr.length !== 3)
        return err("ARITY_ERROR", [], "str-cmp requires 2 args, got " + String(arr.length - 1));
      const sca1R = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!sca1R.ok) return sca1R;
      if (sca1R.value.kind !== "string")
        return err("TYPE_ERROR", [1], "str-cmp requires string, got " + typeName(sca1R.value));
      const sca2R = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!sca2R.ok) return sca2R;
      if (sca2R.value.kind !== "string")
        return err("TYPE_ERROR", [2], "str-cmp requires string, got " + typeName(sca2R.value));
      const scaCmp =
        sca1R.value.value < sca2R.value.value ? -1 : sca1R.value.value > sca2R.value.value ? 1 : 0;
      return ok({ kind: "int", value: BigInt(scaCmp) });
    }

    case "parse-int": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "parse-int requires 1 arg");
      const piR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!piR.ok) return piR;
      if (piR.value.kind !== "string")
        return err("TYPE_ERROR", [1], "parse-int requires string, got " + typeName(piR.value));
      const piN = parseInt(piR.value.value, 10);
      if (isNaN(piN)) return ok(NULL);
      return ok({ kind: "int", value: BigInt(Math.trunc(piN)) });
    }

    case "parse-float": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "parse-float requires 1 arg");
      const pfR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!pfR.ok) return pfR;
      if (pfR.value.kind !== "string")
        return err("TYPE_ERROR", [1], "parse-float requires string, got " + typeName(pfR.value));
      const pfN = parseFloat(pfR.value.value);
      if (isNaN(pfN)) return ok(NULL);
      return ok({ kind: "float", value: pfN });
    }

    // --- Math primitives ---
    case "floor": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "floor requires 1 arg");
      const flR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!flR.ok) return flR;
      if (!isNumeric(flR.value))
        return err("TYPE_ERROR", [1], "floor requires number, got " + typeName(flR.value));
      if (isInt(flR.value)) return ok(flR.value);
      return ok({ kind: "float", value: Math.floor(flR.value.value) });
    }

    case "ceil": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "ceil requires 1 arg");
      const ceR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!ceR.ok) return ceR;
      if (!isNumeric(ceR.value))
        return err("TYPE_ERROR", [1], "ceil requires number, got " + typeName(ceR.value));
      if (isInt(ceR.value)) return ok(ceR.value);
      return ok({ kind: "float", value: Math.ceil(ceR.value.value) });
    }

    case "round": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "round requires 1 arg");
      const roR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!roR.ok) return roR;
      if (!isNumeric(roR.value))
        return err("TYPE_ERROR", [1], "round requires number, got " + typeName(roR.value));
      if (isInt(roR.value)) return ok(roR.value);
      return ok({ kind: "float", value: Math.round(roR.value.value) });
    }

    case "abs": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "abs requires 1 arg");
      const abR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!abR.ok) return abR;
      if (isInt(abR.value))
        return ok({
          kind: "int",
          value: abR.value.value < 0n ? -abR.value.value : abR.value.value,
        });
      if (abR.value.kind === "float")
        return ok({ kind: "float", value: Math.abs(abR.value.value) });
      return err("TYPE_ERROR", [1], "abs requires number, got " + typeName(abR.value));
    }

    case "min": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "min requires 2 args");
      const mnAR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!mnAR.ok) return mnAR;
      const mnBR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!mnBR.ok) return mnBR;
      if (!isNumeric(mnAR.value))
        return err("TYPE_ERROR", [1], "min requires number, got " + typeName(mnAR.value));
      if (!isNumeric(mnBR.value))
        return err("TYPE_ERROR", [2], "min requires number, got " + typeName(mnBR.value));
      if (isInt(mnAR.value) && isInt(mnBR.value))
        return ok({
          kind: "int",
          value: mnAR.value.value < mnBR.value.value ? mnAR.value.value : mnBR.value.value,
        });
      return ok({ kind: "float", value: Math.min(toFloat(mnAR.value), toFloat(mnBR.value)) });
    }

    case "max": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "max requires 2 args");
      const mxAR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!mxAR.ok) return mxAR;
      const mxBR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!mxBR.ok) return mxBR;
      if (!isNumeric(mxAR.value))
        return err("TYPE_ERROR", [1], "max requires number, got " + typeName(mxAR.value));
      if (!isNumeric(mxBR.value))
        return err("TYPE_ERROR", [2], "max requires number, got " + typeName(mxBR.value));
      if (isInt(mxAR.value) && isInt(mxBR.value))
        return ok({
          kind: "int",
          value: mxAR.value.value > mxBR.value.value ? mxAR.value.value : mxBR.value.value,
        });
      return ok({ kind: "float", value: Math.max(toFloat(mxAR.value), toFloat(mxBR.value)) });
    }

    case "pow": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "pow requires 2 args");
      const pwAR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!pwAR.ok) return pwAR;
      const pwBR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!pwBR.ok) return pwBR;
      if (!isNumeric(pwAR.value))
        return err("TYPE_ERROR", [1], "pow requires number, got " + typeName(pwAR.value));
      if (!isNumeric(pwBR.value))
        return err("TYPE_ERROR", [2], "pow requires number, got " + typeName(pwBR.value));
      return ok({ kind: "float", value: Math.pow(toFloat(pwAR.value), toFloat(pwBR.value)) });
    }

    case "sqrt": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "sqrt requires 1 arg");
      const sqR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!sqR.ok) return sqR;
      if (!isNumeric(sqR.value))
        return err("TYPE_ERROR", [1], "sqrt requires number, got " + typeName(sqR.value));
      return ok({ kind: "float", value: Math.sqrt(toFloat(sqR.value)) });
    }

    case "int->float": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "int->float requires 1 arg");
      const ifR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!ifR.ok) return ifR;
      if (!isInt(ifR.value))
        return err("TYPE_ERROR", [1], "int->float requires int, got " + typeName(ifR.value));
      return ok({ kind: "float", value: Number(ifR.value.value) });
    }

    case "float->int": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "float->int requires 1 arg");
      const fiR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!fiR.ok) return fiR;
      if (fiR.value.kind !== "float")
        return err("TYPE_ERROR", [1], "float->int requires float, got " + typeName(fiR.value));
      return ok({ kind: "int", value: BigInt(Math.trunc(fiR.value.value)) });
    }

    // --- Bitwise primitives ---
    case "bit-and": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "bit-and requires 2 args");
      const baAR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!baAR.ok) return baAR;
      const baBR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!baBR.ok) return baBR;
      if (!isInt(baAR.value))
        return err("TYPE_ERROR", [1], "bit-and requires int, got " + typeName(baAR.value));
      if (!isInt(baBR.value))
        return err("TYPE_ERROR", [2], "bit-and requires int, got " + typeName(baBR.value));
      return ok({ kind: "int", value: baAR.value.value & baBR.value.value });
    }

    case "bit-or": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "bit-or requires 2 args");
      const boAR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!boAR.ok) return boAR;
      const boBR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!boBR.ok) return boBR;
      if (!isInt(boAR.value))
        return err("TYPE_ERROR", [1], "bit-or requires int, got " + typeName(boAR.value));
      if (!isInt(boBR.value))
        return err("TYPE_ERROR", [2], "bit-or requires int, got " + typeName(boBR.value));
      return ok({ kind: "int", value: boAR.value.value | boBR.value.value });
    }

    case "bit-xor": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "bit-xor requires 2 args");
      const bxAR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!bxAR.ok) return bxAR;
      const bxBR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!bxBR.ok) return bxBR;
      if (!isInt(bxAR.value))
        return err("TYPE_ERROR", [1], "bit-xor requires int, got " + typeName(bxAR.value));
      if (!isInt(bxBR.value))
        return err("TYPE_ERROR", [2], "bit-xor requires int, got " + typeName(bxBR.value));
      return ok({ kind: "int", value: bxAR.value.value ^ bxBR.value.value });
    }

    case "bit-not": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "bit-not requires 1 arg");
      const bnAR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!bnAR.ok) return bnAR;
      if (!isInt(bnAR.value))
        return err("TYPE_ERROR", [1], "bit-not requires int, got " + typeName(bnAR.value));
      return ok({ kind: "int", value: ~bnAR.value.value });
    }

    case "bit-shl": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "bit-shl requires 2 args");
      const bslAR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!bslAR.ok) return bslAR;
      const bslNR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!bslNR.ok) return bslNR;
      if (!isInt(bslAR.value))
        return err("TYPE_ERROR", [1], "bit-shl requires int, got " + typeName(bslAR.value));
      if (!isInt(bslNR.value))
        return err(
          "TYPE_ERROR",
          [2],
          "bit-shl shift amount must be int, got " + typeName(bslNR.value),
        );
      return ok({ kind: "int", value: bslAR.value.value << bslNR.value.value });
    }

    case "bit-shr": {
      if (arr.length !== 3) return err("ARITY_ERROR", [], "bit-shr requires 2 args");
      const bsrAR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!bsrAR.ok) return bsrAR;
      const bsrNR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!bsrNR.ok) return bsrNR;
      if (!isInt(bsrAR.value))
        return err("TYPE_ERROR", [1], "bit-shr requires int, got " + typeName(bsrAR.value));
      if (!isInt(bsrNR.value))
        return err(
          "TYPE_ERROR",
          [2],
          "bit-shr shift amount must be int, got " + typeName(bsrNR.value),
        );
      return ok({ kind: "int", value: bsrAR.value.value >> bsrNR.value.value });
    }

    // --- String ops ---
    case "concat": {
      if (arr.length < 2) return err("ARITY_ERROR", [], "concat requires at least 1 arg");
      let result = "";
      for (let i = 1; i < arr.length; i++) {
        const r = prependPath(yield* evalGen(at(arr, i), env), i);
        if (!r.ok) return r;
        if (r.value.kind !== "string") {
          return err("TYPE_ERROR", [i], "concat requires string, got " + typeName(r.value));
        }
        result += r.value.value;
      }
      return ok({ kind: "string", value: result });
    }

    case "slice": {
      if (arr.length !== 4) return err("ARITY_ERROR", [], "slice requires 3 args");
      const sR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!sR.ok) return sR;
      if (sR.value.kind !== "string") {
        return err("TYPE_ERROR", [1], "slice requires string, got " + typeName(sR.value));
      }
      const startR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!startR.ok) return startR;
      if (!isInt(startR.value)) {
        return err("TYPE_ERROR", [2], "slice start must be int, got " + typeName(startR.value));
      }
      const endR = prependPath(yield* evalGen(at(arr, 3), env), 3);
      if (!endR.ok) return endR;
      if (!isInt(endR.value)) {
        return err("TYPE_ERROR", [3], "slice end must be int, got " + typeName(endR.value));
      }
      const s = sR.value.value;
      const start = Number(startR.value.value);
      const end = Number(endR.value.value);
      return ok({ kind: "string", value: s.slice(start, end) });
    }

    case "to-string": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "to-string requires 1 arg");
      const valR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!valR.ok) return valR;
      return ok({ kind: "string", value: valueToString(valR.value) });
    }

    case "parse-number": {
      if (arr.length !== 2) return err("ARITY_ERROR", [], "parse-number requires 1 arg");
      const valR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!valR.ok) return valR;
      if (valR.value.kind !== "string") {
        return err("TYPE_ERROR", [1], "parse-number requires string, got " + typeName(valR.value));
      }
      const s = valR.value.value.trim();
      if (s === "") return ok(NULL);
      // Try integer first
      if (/^-?\d+$/.test(s)) {
        try {
          return ok({ kind: "int", value: BigInt(s) });
        } catch {
          // fallthrough
        }
      }
      // Try float
      const n = Number(s);
      if (!isNaN(n)) {
        return ok({ kind: "float", value: n });
      }
      return ok(NULL);
    }

    // --- Functions ---
    // fn-once is a linearity-only annotation; at runtime it behaves identically to fn.
    case "fn-once":
    case "fn": {
      // ["fn", params, body]  params is array of strings (or [name, type] pairs — we take name only)
      if (arr.length !== 3) return err("ARITY_ERROR", [], op + " requires 2 args");
      const paramsExpr = arr[1];
      if (!Array.isArray(paramsExpr)) {
        return err("TYPE_ERROR", [1], op + " params must be an array");
      }
      const params: string[] = [];
      for (let i = 0; i < paramsExpr.length; i++) {
        const p = paramsExpr[i];
        if (typeof p === "string") {
          params.push(p);
        } else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") {
          // [name, type] annotation — take just the name
          params.push(p[0]);
        } else {
          return err("TYPE_ERROR", [1, i], op + " param must be a string or [name, type] pair");
        }
      }
      return ok({ kind: "fn", params, body: at(arr, 2), env });
    }

    case "call": {
      // ["call", fn, arg1, arg2, ...]
      if (arr.length < 2) return err("ARITY_ERROR", [], "call requires at least 1 arg");
      const fnR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!fnR.ok) return fnR;
      const args: Value[] = [];
      for (let i = 2; i < arr.length; i++) {
        const r = prependPath(yield* evalGen(at(arr, i), env), i);
        if (!r.ok) return r;
        args.push(r.value);
      }
      return yield* callFnGen(fnR.value, args, []);
    }

    // --- Match ---
    case "match": {
      // ["match", expr, [["Tag", "b1", ...], body], ...]
      // Pattern tag can be:
      //   - string: variant tag (when scrutinee is a variant), or string/null/bool literal otherwise
      //     - "null" matches { kind: "null" }
      //     - "true" / "false" matches { kind: "bool", value: true/false }
      //     - any other string matches { kind: "string", value: tag }
      //   - number (JS number): matches { kind: "int", value: BigInt(tag) } or { kind: "float", value: tag }
      //   - boolean: matches { kind: "bool", value: tag }
      //   - null: matches { kind: "null" }
      if (arr.length < 3) return err("ARITY_ERROR", [], "match requires at least 2 args");
      const scrutR = prependPath(yield* evalGen(at(arr, 1), env), 1);
      if (!scrutR.ok) return scrutR;
      const scrutVal = scrutR.value;

      for (let i = 2; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          return err("TYPE_ERROR", [i], "match clause must be [pattern, body]");
        }
        const pattern = clause[0];
        const body = clause[1] as Expr;
        if (!Array.isArray(pattern) || pattern.length < 1) {
          return err("TYPE_ERROR", [i, 0], "match pattern must be an array starting with a tag");
        }
        const tag = pattern[0];

        if (scrutVal.kind === "variant") {
          // Variant matching: tag must be a string identifier
          if (typeof tag !== "string") {
            return err(
              "TYPE_ERROR",
              [i, 0],
              "match pattern tag must be a string for variant scrutinee",
            );
          }
          if (scrutVal.tag !== tag) continue;
          // Check field count
          const bindingNames = pattern.slice(1);
          if (bindingNames.length !== scrutVal.fields.length) {
            return err(
              "ARITY_ERROR",
              [i, 0],
              "pattern " +
                tag +
                " expects " +
                String(bindingNames.length) +
                " bindings, variant has " +
                String(scrutVal.fields.length) +
                " fields",
            );
          }
          // Bind fields
          const bindings: Record<string, Value> = {};
          for (let j = 0; j < bindingNames.length; j++) {
            const bName = bindingNames[j];
            if (typeof bName !== "string") {
              return err("TYPE_ERROR", [i, 0, j + 1], "match binding name must be a string");
            }
            bindings[bName] = scrutVal.fields[j] as Value;
          }
          return prependPath(yield* evalGen(body, env.extend(bindings)), i);
        } else {
          // Literal matching: compare tag against scrutinee value
          let matched = false;
          if (tag === null) {
            matched = scrutVal.kind === "null";
          } else if (typeof tag === "boolean") {
            matched = scrutVal.kind === "bool" && scrutVal.value === tag;
          } else if (typeof tag === "number") {
            if (scrutVal.kind === "int") {
              matched = scrutVal.value === BigInt(tag);
            } else if (scrutVal.kind === "float") {
              matched = scrutVal.value === tag;
            }
          } else {
            // string tag
            if (tag === "null") {
              matched = scrutVal.kind === "null";
            } else if (tag === "true") {
              matched = scrutVal.kind === "bool" && scrutVal.value === true;
            } else if (tag === "false") {
              matched = scrutVal.kind === "bool" && scrutVal.value === false;
            } else {
              matched = scrutVal.kind === "string" && scrutVal.value === tag;
            }
          }
          if (!matched) continue;
          // Literal patterns support an optional single binding for the scrutinee value
          const bindingNames = pattern.slice(1);
          if (bindingNames.length > 1) {
            return err("ARITY_ERROR", [i, 0], "literal pattern can have at most one binding");
          }
          if (bindingNames.length === 1) {
            const bName = bindingNames[0];
            if (typeof bName !== "string") {
              return err("TYPE_ERROR", [i, 0, 1], "match binding name must be a string");
            }
            return prependPath(yield* evalGen(body, env.extend({ [bName]: scrutVal })), i);
          }
          return prependPath(yield* evalGen(body, env), i);
        }
      }

      // No pattern matched
      if (scrutVal.kind === "variant") {
        return err(
          "NON_EXHAUSTIVE_MATCH",
          [],
          "non-exhaustive match: no clause for variant " + scrutVal.tag,
        );
      }
      return err("NON_EXHAUSTIVE_MATCH", [], "non-exhaustive match: no clause matched");
    }

    case "cond": {
      // ["cond", [test1, expr1], [test2, expr2], ..., ["else", exprN]]
      if (arr.length < 2) return err("ARITY_ERROR", [], "cond requires at least 1 clause");
      for (let i = 1; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          return err("TYPE_ERROR", [i], "cond clause must be [test, expr]");
        }
        const test = clause[0];
        const body = clause[1] as Expr;
        if (test === "else") {
          return prependPath(yield* evalGen(body, env), i);
        }
        const testR = prependPath(yield* evalGen(test as Expr, env), i);
        if (!testR.ok) return testR;
        if (testR.value.kind !== "bool") {
          return err("TYPE_ERROR", [i, 0], "cond test must be bool, got " + typeName(testR.value));
        }
        if (testR.value.value) {
          return prependPath(yield* evalGen(body, env), i);
        }
      }
      return err("NON_EXHAUSTIVE_COND", [], "non-exhaustive cond: no clause matched");
    }

    // --- Effects ---
    case "perform": {
      // ["perform", tag, payload]
      if (arr.length !== 3) return err("ARITY_ERROR", [], "perform requires 2 args");
      const tagExpr = arr[1];
      if (typeof tagExpr !== "string") {
        return err("TYPE_ERROR", [1], "perform tag must be a string");
      }
      const payloadR = prependPath(yield* evalGen(at(arr, 2), env), 2);
      if (!payloadR.ok) return payloadR;
      // Yield the effect; receive the resume value from the handler
      const resumeVal: Value = yield { tag: tagExpr, payload: payloadR.value };
      return ok(resumeVal);
    }

    case "handle": {
      // ["handle", expr, clause1, clause2, ..., ?returnClause]
      // Each clause: [["EffectTag", "payloadBinding", "k"], body]
      // Return clause: [["return", "x"], body]
      if (arr.length < 2) return err("ARITY_ERROR", [], "handle requires at least 1 arg");

      // Parse clauses
      const effectClauses: EffectClause[] = [];
      let returnClause: ReturnClause | null = null;

      for (let i = 2; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          return err("TYPE_ERROR", [i], "handle clause must be [pattern, body]");
        }
        const pattern = clause[0];
        const body = clause[1] as Expr;
        if (!Array.isArray(pattern) || pattern.length < 1) {
          return err(
            "TYPE_ERROR",
            [i, 0],
            "handle clause pattern must be an array starting with a tag",
          );
        }
        const tag = pattern[0];
        if (typeof tag !== "string") {
          return err("TYPE_ERROR", [i, 0], "handle clause tag must be a string");
        }
        if (tag === "return") {
          // Return clause: [["return", "x"], body]
          if (pattern.length !== 2 || typeof pattern[1] !== "string") {
            return err("TYPE_ERROR", [i, 0], 'return clause must be ["return", bindingName]');
          }
          returnClause = { kind: "return", binding: pattern[1], body };
        } else {
          // Effect clause: [["EffectTag", "payloadBinding", "k"], body]
          if (
            pattern.length !== 3 ||
            typeof pattern[1] !== "string" ||
            typeof pattern[2] !== "string"
          ) {
            return err(
              "TYPE_ERROR",
              [i, 0],
              'effect clause must be ["EffectTag", payloadBinding, kBinding]',
            );
          }
          effectClauses.push({
            kind: "effect",
            tag,
            payloadBinding: pattern[1],
            kBinding: pattern[2],
            body,
          });
        }
      }

      // Run inner expression as a generator
      const innerGen = evalGen(at(arr, 1), env);
      const firstStep = innerGen.next();
      return yield* dispatchHandler(innerGen, firstStep, effectClauses, returnClause, env);
    }

    default:
      return err("UNKNOWN_OP", [], "unknown op: " + op);
  }
}

// --- Type checking for "is" / "as" ---

function checkType(v: Value, typStr: string): boolean {
  switch (typStr) {
    case "null":
      return v.kind === "null";
    case "bool":
    case "boolean":
      return v.kind === "bool";
    case "int":
      return v.kind === "int";
    case "float":
      return v.kind === "float";
    case "number":
      return v.kind === "int" || v.kind === "float";
    case "string":
      return v.kind === "string";
    case "array":
      return v.kind === "array";
    case "record":
      return v.kind === "record";
    case "bytes":
      return v.kind === "bytes";
    case "fn":
      return v.kind === "fn";
    case "variant":
      return v.kind === "variant";
    case "cap":
      return v.kind === "cap";
    case "continuation":
      return v.kind === "continuation";
    default:
      return false;
  }
}

// --- Public API ---

export { Env, EMPTY_ENV };
export type { Value };

export function evaluate(expr: Expr, env: Env = EMPTY_ENV): EvalResult {
  const gen = evalGen(expr, env);
  let step = gen.next();
  while (!step.done) {
    // An effect was yielded with no handler — this is an error
    return {
      ok: false,
      error: {
        code: "UNHANDLED_EFFECT",
        path: [],
        message: "unhandled effect: " + step.value.tag,
      },
    };
  }
  return step.value;
}

/** Convenience: build a record Value from a plain object. */
export function recordValue(obj: Record<string, Value>): Value {
  return { kind: "record", value: new Map(Object.entries(obj)) };
}
