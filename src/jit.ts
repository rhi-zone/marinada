import type { Expr } from "./types.ts";
import {
  optimize,
  CONSTANT_FOLDING_RULES,
  inlineSmallFunctions,
  tco,
  recognizeLoopPatterns,
  fuseLoops,
} from "./optimizer.ts";
import type { TypeInfo } from "./typecheck.ts";
import type { Effect } from "./evaluate.ts";

// A compiled Marinada expression.
// Takes an env (variable bindings) and returns a JS-native value.
export type JitFn = (env: Record<string, unknown>) => unknown;

export class CompileError extends Error {
  constructor(
    message: string,
    public readonly path: number[],
  ) {
    super(message);
    this.name = "CompileError";
  }
}

// --- Runtime helpers ---

function _eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => _eq(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    return ak.length === bk.length && ak.every((k) => _eq(ao[k], bo[k]));
  }
  return false;
}

const RUNTIME = {
  _add(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") return a + b;
    return Number(a) + Number(b);
  },
  _sub(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") return a - b;
    return Number(a) - Number(b);
  },
  _mul(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") return a * b;
    return Number(a) * Number(b);
  },
  _div(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") {
      if (b === 0n) throw new RangeError("integer division by zero");
      return a / b;
    }
    return Number(a) / Number(b);
  },
  _mod(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") {
      if (b === 0n) throw new RangeError("integer modulo by zero");
      return a % b;
    }
    return Number(a) % Number(b);
  },
  _eq(a: unknown, b: unknown): boolean {
    return _eq(a, b);
  },
  _get(obj: unknown, key: unknown): unknown {
    if (Array.isArray(obj)) {
      const idx = typeof key === "bigint" ? Number(key) : (key as number);
      if (idx < 0 || idx >= obj.length) return null;
      return (obj[idx] as unknown) ?? null;
    }
    if (obj !== null && typeof obj === "object") {
      const k = String(key);
      const val = (obj as Record<string, unknown>)[k];
      return val === undefined ? null : val;
    }
    return null;
  },
  _set(obj: unknown, key: unknown, val: unknown): unknown {
    if (Array.isArray(obj)) {
      const idx = typeof key === "bigint" ? Number(key) : (key as number);
      const newArr = [...obj];
      newArr[idx] = val;
      return newArr;
    }
    if (obj !== null && typeof obj === "object") {
      return { ...(obj as object), [String(key)]: val };
    }
    return obj;
  },
  _getIn(obj: unknown, path: unknown[]): unknown {
    let current = obj;
    for (const key of path) {
      current = RUNTIME._get(current, key);
    }
    return current;
  },
  _setIn(obj: unknown, path: unknown[], val: unknown): unknown {
    if (path.length === 0) return val;
    const key = path[0]!;
    const child = RUNTIME._get(obj, key);
    const newChild = RUNTIME._setIn(child, path.slice(1), val);
    return RUNTIME._set(obj, key, newChild);
  },
  _merge(r1: unknown, r2: unknown): unknown {
    return { ...(r1 as object), ...(r2 as object) };
  },
  _keys(r: unknown): unknown[] {
    if (r !== null && typeof r === "object" && !Array.isArray(r)) {
      return Object.keys(r as object);
    }
    return [];
  },
  _vals(r: unknown): unknown[] {
    if (r !== null && typeof r === "object" && !Array.isArray(r)) {
      return Object.values(r as object);
    }
    return [];
  },
  _count(a: unknown): bigint {
    if (Array.isArray(a)) return BigInt(a.length);
    if (a !== null && typeof a === "object") return BigInt(Object.keys(a as object).length);
    return 0n;
  },
  _toStr(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") return v.toString();
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return `[${(v as unknown[]).map((x) => RUNTIME._toStr(x)).join(", ")}]`;
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const tag = o["$tag"];
      if (typeof tag === "string") {
        // variant
        const fields = Object.keys(o)
          .filter((k) => k !== "$tag")
          .map((k) => RUNTIME._toStr(o[k]));
        if (fields.length === 0) return tag;
        return `${tag}(${fields.join(", ")})`;
      }
      const entries = Object.entries(o).map(([k, val]) => `${k}: ${RUNTIME._toStr(val)}`);
      return `{${entries.join(", ")}}`;
    }
    return String(v);
  },
  _parseNum(s: unknown): unknown {
    if (typeof s !== "string") return null;
    const trimmed = s.trim();
    if (trimmed === "") return null;
    if (/^-?\d+$/.test(trimmed)) {
      try {
        return BigInt(trimmed);
      } catch {
        // fallthrough
      }
    }
    const n = Number(trimmed);
    if (!isNaN(n)) return n;
    return null;
  },
  _variant(tag: string, ...fields: unknown[]): unknown {
    const obj: Record<string, unknown> = { $tag: tag };
    for (let i = 0; i < fields.length; i++) {
      obj[`$${i}`] = fields[i];
    }
    return obj;
  },
  _slice(s: unknown, start: unknown, end: unknown): string {
    const str = s as string;
    const st = typeof start === "bigint" ? Number(start) : (start as number);
    const en = typeof end === "bigint" ? Number(end) : (end as number);
    return str.slice(st, en);
  },
  _arrayGet(arr: unknown, idx: unknown): unknown {
    if (!Array.isArray(arr)) return null;
    const i = typeof idx === "bigint" ? Number(idx) : (idx as number);
    if (i < 0 || i >= arr.length) return null;
    return (arr[i] as unknown) ?? null;
  },
  _strGet(s: unknown, idx: unknown): bigint | null {
    const str = s as string;
    const i = typeof idx === "bigint" ? Number(idx) : (idx as number);
    const cp = str.codePointAt(i);
    if (cp === undefined) return null;
    return BigInt(cp);
  },
  _strCmp(a: unknown, b: unknown): bigint {
    const sa = a as string;
    const sb = b as string;
    if (sa < sb) return -1n;
    if (sa > sb) return 1n;
    return 0n;
  },
  _parseInt(s: unknown): bigint | null {
    if (typeof s !== "string") return null;
    const n = parseInt(s, 10);
    if (isNaN(n)) return null;
    return BigInt(Math.trunc(n));
  },
  _parseFloat(s: unknown): number | null {
    if (typeof s !== "string") return null;
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    return n;
  },
  _intToFloat(x: unknown): number {
    return Number(x as bigint);
  },
  _floatToInt(x: unknown): bigint {
    return BigInt(Math.trunc(x as number));
  },
  _bitNot(a: unknown): bigint {
    return ~(a as bigint);
  },
  _recordDel(r: unknown, k: unknown): unknown {
    const o = { ...(r as object) } as Record<string, unknown>;
    delete o[String(k)];
    return o;
  },
  _floor(x: unknown): unknown {
    return typeof x === "bigint" ? x : Math.floor(x as number);
  },
  _ceil(x: unknown): unknown {
    return typeof x === "bigint" ? x : Math.ceil(x as number);
  },
  _round(x: unknown): unknown {
    return typeof x === "bigint" ? x : Math.round(x as number);
  },
  _abs(x: unknown): unknown {
    if (typeof x === "bigint") return x < 0n ? -x : x;
    return Math.abs(x as number);
  },
  _min(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") return a < b ? a : b;
    return Math.min(Number(a), Number(b));
  },
  _max(a: unknown, b: unknown): unknown {
    if (typeof a === "bigint" && typeof b === "bigint") return a > b ? a : b;
    return Math.max(Number(a), Number(b));
  },
  _asCheck(typ: string, v: unknown): unknown {
    if (!_isCheck(typ, v)) throw new TypeError(`expected ${typ}`);
    return v;
  },
};

function _isCheck(typ: string, v: unknown): boolean {
  switch (typ) {
    case "null":
      return v === null;
    case "bool":
    case "boolean":
      return typeof v === "boolean";
    case "int":
      return typeof v === "bigint";
    case "float":
      return typeof v === "number";
    case "number":
      return typeof v === "bigint" || typeof v === "number";
    case "string":
      return typeof v === "string";
    case "array":
      return Array.isArray(v);
    case "record":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "variant":
      return (
        v !== null &&
        typeof v === "object" &&
        typeof (v as Record<string, unknown>)["$tag"] === "string"
      );
    default:
      return false;
  }
}

// --- Natives table ---

const NATIVES = {
  array_map(xs: unknown, f: unknown): unknown[] {
    return (xs as unknown[]).map((x) => (f as (v: unknown) => unknown)(x));
  },
  array_filter(xs: unknown, f: unknown): unknown[] {
    return (xs as unknown[]).filter((x) => (f as (v: unknown) => boolean)(x));
  },
  array_reduce(xs: unknown, f: unknown, init: unknown): unknown {
    return (xs as unknown[]).reduce(
      (a: unknown, b: unknown) => (f as (a: unknown, b: unknown) => unknown)(a, b),
      init,
    );
  },
  array_find(xs: unknown, f: unknown): unknown {
    return (xs as unknown[]).find((x) => (f as (v: unknown) => boolean)(x)) ?? null;
  },
  array_every(xs: unknown, f: unknown): boolean {
    return (xs as unknown[]).every((x) => (f as (v: unknown) => boolean)(x));
  },
  array_any(xs: unknown, f: unknown): boolean {
    return (xs as unknown[]).some((x) => (f as (v: unknown) => boolean)(x));
  },
  array_flat_map(xs: unknown, f: unknown): unknown[] {
    return (xs as unknown[]).flatMap((x) => (f as (v: unknown) => unknown[])(x));
  },
  array_includes(xs: unknown, v: unknown): boolean {
    return (xs as unknown[]).some((x) => _eq(x, v));
  },
  array_index_of(xs: unknown, v: unknown): bigint {
    const arr = xs as unknown[];
    for (let i = 0; i < arr.length; i++) {
      if (_eq(arr[i], v)) return BigInt(i);
    }
    return -1n;
  },
  array_map_filter(xs: unknown, pred: unknown, f: unknown): unknown[] {
    const arr = xs as unknown[];
    const p = pred as (v: unknown) => boolean;
    const fn = f as (v: unknown) => unknown;
    const out: unknown[] = [];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (p(v)) out.push(fn(v));
    }
    return out;
  },
  array_filter_map(xs: unknown, f: unknown, pred: unknown): unknown[] {
    const arr = xs as unknown[];
    const fn = f as (v: unknown) => unknown;
    const p = pred as (v: unknown) => boolean;
    const out: unknown[] = [];
    for (let i = 0; i < arr.length; i++) {
      const v = fn(arr[i]);
      if (p(v)) out.push(v);
    }
    return out;
  },
  array_map_reduce(xs: unknown, g: unknown, f: unknown, init: unknown): unknown {
    const arr = xs as unknown[];
    const gn = g as (v: unknown) => unknown;
    const fn = f as (a: unknown, b: unknown) => unknown;
    let acc = init;
    for (let i = 0; i < arr.length; i++) acc = fn(acc, gn(arr[i]));
    return acc;
  },
};

// --- JS AST IR ---

export type JSExpr =
  | { t: "lit"; v: string } // pre-serialized literal text
  | { t: "id"; name: string }
  | { t: "call"; fn: JSExpr; args: JSExpr[] }
  | { t: "idx"; obj: JSExpr; key: JSExpr }
  | { t: "member"; obj: JSExpr; prop: string }
  | { t: "arrow"; params: string[]; body: JSExpr | { stmts: JSStmt[] } }
  | { t: "cond"; test: JSExpr; cons: JSExpr; else: JSExpr }
  | { t: "assign"; lhs: string; rhs: JSExpr }
  | { t: "seq"; exprs: JSExpr[] }
  | { t: "iife"; body: JSStmt[] }
  | { t: "array"; elems: JSExpr[] }
  | { t: "object"; props: [string, JSExpr][] }
  | { t: "new"; ctor: JSExpr; args: JSExpr[] }
  | { t: "unary"; op: string; expr: JSExpr; prefix?: boolean }
  | { t: "binary"; op: string; left: JSExpr; right: JSExpr }
  | { t: "yield"; expr: JSExpr }
  | { t: "yield-star"; expr: JSExpr };

export type JSStmt =
  | { t: "expr"; expr: JSExpr }
  | { t: "return"; expr: JSExpr }
  | { t: "let"; name: string; init: JSExpr }
  | { t: "var"; name: string }
  | { t: "assign-stmt"; lhs: string; rhs: JSExpr }
  | { t: "while"; label: string; body: JSStmt[] }
  | { t: "continue"; label: string }
  | { t: "break"; label: string }
  | { t: "if-stmt"; test: JSExpr; cons: JSStmt[]; else?: JSStmt[] }
  | { t: "block"; stmts: JSStmt[] }
  | { t: "throw"; expr: JSExpr };

// --- Builders ---

const J = {
  lit: (v: string): JSExpr => ({ t: "lit", v }),
  id: (name: string): JSExpr => ({ t: "id", name }),
  call: (fn: JSExpr, args: JSExpr[]): JSExpr => ({ t: "call", fn, args }),
  idx: (obj: JSExpr, key: JSExpr): JSExpr => ({ t: "idx", obj, key }),
  member: (obj: JSExpr, prop: string): JSExpr => ({ t: "member", obj, prop }),
  cond: (test: JSExpr, cons: JSExpr, els: JSExpr): JSExpr => ({
    t: "cond",
    test,
    cons,
    else: els,
  }),
  binary: (op: string, left: JSExpr, right: JSExpr): JSExpr => ({
    t: "binary",
    op,
    left,
    right,
  }),
  unary: (op: string, expr: JSExpr): JSExpr => ({ t: "unary", op, expr }),
  rt: (method: string): JSExpr => ({
    t: "member",
    obj: { t: "id", name: "_rt" },
    prop: method,
  }),
  rtCall: (method: string, args: JSExpr[]): JSExpr => J.call(J.rt(method), args),
  yield: (expr: JSExpr): JSExpr => ({ t: "yield", expr }),
  yieldStar: (expr: JSExpr): JSExpr => ({ t: "yield-star", expr }),
  object: (props: [string, JSExpr][]): JSExpr => ({ t: "object", props }),
};

// --- Serializer ---

function precedence(e: JSExpr): number {
  // Higher = tighter binding. Used to decide on parenthesization.
  switch (e.t) {
    case "lit":
    case "id":
    case "array":
    case "object":
    case "iife":
      return 100;
    case "member":
    case "idx":
    case "call":
    case "new":
      return 90;
    case "unary":
      return 80;
    case "binary": {
      switch (e.op) {
        case "*":
        case "/":
        case "%":
          return 70;
        case "+":
        case "-":
          return 65;
        case "<<":
        case ">>":
        case ">>>":
          return 60;
        case "<":
        case "<=":
        case ">":
        case ">=":
          return 55;
        case "==":
        case "!=":
        case "===":
        case "!==":
          return 50;
        case "&":
          return 45;
        case "^":
          return 44;
        case "|":
          return 43;
        case "&&":
          return 40;
        case "||":
        case "??":
          return 35;
        default:
          return 30;
      }
    }
    case "cond":
      return 20;
    case "assign":
      return 10;
    case "arrow":
      return 10;
    case "yield":
    case "yield-star":
      return 5;
    case "seq":
      return 1;
  }
}

function paren(inner: JSExpr, parentPrec: number): string {
  const ip = precedence(inner);
  const s = serializeExpr(inner);
  if (ip < parentPrec) return `(${s})`;
  return s;
}

export function serializeExpr(e: JSExpr): string {
  switch (e.t) {
    case "lit":
      return e.v;
    case "id":
      return e.name;
    case "call": {
      const fn = paren(e.fn, 90);
      const args = e.args.map((a) => paren(a, 2)).join(", ");
      return `${fn}(${args})`;
    }
    case "idx":
      return `${paren(e.obj, 90)}[${serializeExpr(e.key)}]`;
    case "member":
      return `${paren(e.obj, 90)}.${e.prop}`;
    case "arrow": {
      const params = `(${e.params.join(", ")})`;
      if ("stmts" in e.body) {
        return `${params} => { ${e.body.stmts.map(serializeStmt).join(" ")} }`;
      }
      // expression body — wrap object literals so they aren't parsed as block
      const b = e.body;
      if (b.t === "object") return `${params} => (${serializeExpr(b)})`;
      return `${params} => ${paren(b, 2)}`;
    }
    case "cond":
      return `${paren(e.test, 21)} ? ${paren(e.cons, 11)} : ${paren(e.else, 11)}`;
    case "assign":
      return `${e.lhs} = ${paren(e.rhs, 11)}`;
    case "seq":
      return e.exprs.map((x) => paren(x, 2)).join(", ");
    case "iife": {
      return `(() => { ${e.body.map(serializeStmt).join(" ")} })()`;
    }
    case "array":
      return `[${e.elems.map((x) => paren(x, 2)).join(", ")}]`;
    case "object":
      return `{${e.props.map(([k, v]) => `${JSON.stringify(k)}: ${paren(v, 2)}`).join(", ")}}`;
    case "new": {
      const ctor = paren(e.ctor, 90);
      const args = e.args.map((a) => paren(a, 2)).join(", ");
      return `new ${ctor}(${args})`;
    }
    case "unary":
      return `${e.op}${paren(e.expr, 80)}`;
    case "binary": {
      const p = precedence(e);
      return `${paren(e.left, p)} ${e.op} ${paren(e.right, p + 1)}`;
    }
    case "yield":
      return `(yield ${paren(e.expr, 2)})`;
    case "yield-star":
      return `(yield* ${paren(e.expr, 2)})`;
  }
}

export function serializeStmt(s: JSStmt): string {
  switch (s.t) {
    case "expr":
      return `${serializeExpr(s.expr)};`;
    case "return":
      return `return ${serializeExpr(s.expr)};`;
    case "let":
      return `let ${s.name} = ${serializeExpr(s.init)};`;
    case "var":
      return `var ${s.name};`;
    case "assign-stmt":
      return `${s.lhs} = ${serializeExpr(s.rhs)};`;
    case "while": {
      const body = s.body.map(serializeStmt).join(" ");
      return `${s.label}: while (true) { ${body} }`;
    }
    case "continue":
      return `continue ${s.label};`;
    case "break":
      return `break ${s.label};`;
    case "if-stmt": {
      const t = s.cons.map(serializeStmt).join(" ");
      const e = s.else ? ` else { ${s.else.map(serializeStmt).join(" ")} }` : "";
      return `if (${serializeExpr(s.test)}) { ${t} }${e}`;
    }
    case "block":
      return `{ ${s.stmts.map(serializeStmt).join(" ")} }`;
    case "throw":
      return `throw ${serializeExpr(s.expr)};`;
  }
}

// --- Sanitization & Scope ---

// JS reserved words and identifiers used by the generated code.
// Bindings that sanitize to one of these get a numeric suffix.
const RESERVED: ReadonlySet<string> = new Set([
  // Generated-code identifiers
  "env",
  "_rt",
  "_nat",
  // JS reserved words / future reserved words / contextual keywords
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "await",
  "async",
  // Globals our generated code might reference
  "Array",
  "BigInt",
  "Error",
  "Math",
  "Number",
  "Object",
  "String",
  "TypeError",
  "RangeError",
  "undefined",
  "NaN",
  "Infinity",
  "globalThis",
]);

/** Sanitize a Marinada name to a valid JS identifier base.
 * Replaces any character outside [a-zA-Z0-9_$] with `_`, and prefixes with `_`
 * if the result starts with a digit or is empty. The result is NOT
 * guaranteed unique — `Scope.bind` handles disambiguation. */
function sanitize(name: string): string {
  let safe = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  if (safe === "" || /^[0-9]/.test(safe)) safe = "_" + safe;
  return safe;
}

/** Lexical scope: maps Marinada names to JS identifiers, with parent chain. */
class Scope {
  private readonly bindings = new Map<string, string>();
  constructor(
    readonly parent: Scope | null,
    readonly taken: Set<string>,
  ) {}

  /** Create a child scope sharing the same compilation-wide taken set. */
  child(): Scope {
    return new Scope(this, this.taken);
  }

  /** Bind `name` to a fresh JS identifier, avoiding all currently-taken names.
   * Returns the JS identifier. */
  bind(name: string): string {
    const base = sanitize(name);
    let candidate = base;
    let i = 1;
    while (this.taken.has(candidate) || RESERVED.has(candidate)) {
      candidate = `${base}_${i++}`;
    }
    this.taken.add(candidate);
    this.bindings.set(name, candidate);
    return candidate;
  }

  /** Generate a fresh internal JS identifier with the given base.
   * Not associated with any Marinada name. */
  gensym(base: string): string {
    let candidate = base;
    let i = 1;
    while (this.taken.has(candidate) || RESERVED.has(candidate)) {
      candidate = `${base}_${i++}`;
    }
    this.taken.add(candidate);
    return candidate;
  }

  /** Walk the scope chain looking for a Marinada name. */
  resolve(name: string): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let s: Scope | null = this;
    while (s !== null) {
      const r = s.bindings.get(name);
      if (r !== undefined) return r;
      s = s.parent;
    }
    return undefined;
  }
}

// --- Compiler ---

type CompileCtx = {
  path: number[];
  /** Lexical scope for variable name resolution. */
  scope: Scope;
  /** When inside a __loop body, the sanitized loop parameter names + label. */
  loop: { params: string[]; label: string } | null;
  /** Counter for generating unique loop labels. */
  loopCounter: { n: number };
  /** When true, yield expressions are valid (we're inside a generator function). */
  inGenerator: boolean;
  /** JS identifiers that hold continuation generators — calls to these emit `yield*`. */
  continuationVars: Set<string>;
};

function emptyCtx(): CompileCtx {
  return {
    path: [],
    scope: new Scope(null, new Set()),
    loop: null,
    loopCounter: { n: 0 },
    inGenerator: false,
    continuationVars: new Set(),
  };
}

function childCtx(ctx: CompileCtx, i: number): CompileCtx {
  return { ...ctx, path: [...ctx.path, i] };
}

/** Create a child context with a fresh nested scope. */
function pushScope(ctx: CompileCtx): CompileCtx {
  return { ...ctx, scope: ctx.scope.child() };
}

function varRef(name: string, ctx: CompileCtx): JSExpr {
  const local = ctx.scope.resolve(name);
  if (local !== undefined) return J.id(local);
  return J.idx(J.id("env"), J.lit(JSON.stringify(name)));
}

/** Serialize a JS value as a JS literal string, matching the JIT's value representation. */
function serializeLit(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return `[${(v as unknown[]).map(serializeLit).join(", ")}]`;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const entries = Object.entries(o).map(
      ([k, val]) => `${JSON.stringify(k)}: ${serializeLit(val)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  throw new Error(`serializeLit: unsupported value type: ${typeof v}`);
}

function compileExpr(expr: Expr, ctx: CompileCtx): JSExpr {
  // Atoms
  if (expr === null) return J.lit("null");
  if (typeof expr === "boolean") return J.lit(expr ? "true" : "false");
  if (typeof expr === "number") {
    if (Number.isInteger(expr) && !Object.is(expr, -0)) {
      return J.lit(`${expr}n`);
    }
    return J.lit(JSON.stringify(expr));
  }
  if (typeof expr === "string") {
    return varRef(expr, ctx);
  }

  const arr = expr as Expr[];
  if (arr.length === 0) {
    throw new CompileError("empty expression array", ctx.path);
  }

  const opExpr = arr[0];
  if (typeof opExpr !== "string") {
    throw new CompileError("first element of call must be an op name (string)", ctx.path);
  }
  const op = opExpr;

  // Variant constructor: uppercase tag
  if (op.length > 0 && (op[0] as string) >= "A" && (op[0] as string) <= "Z") {
    const fieldArgs = arr.slice(1).map((a, i) => compileExpr(a, childCtx(ctx, i + 1)));
    return J.rtCall("_variant", [J.lit(JSON.stringify(op)), ...fieldArgs]);
  }

  const arg = (i: number): JSExpr => compileExpr(arr[i] as Expr, childCtx(ctx, i));

  switch (op) {
    case "+":
      return J.rtCall("_add", [arg(1), arg(2)]);
    case "-":
      return J.rtCall("_sub", [arg(1), arg(2)]);
    case "*":
      return J.rtCall("_mul", [arg(1), arg(2)]);
    case "/":
      return J.rtCall("_div", [arg(1), arg(2)]);
    case "%":
      return J.rtCall("_mod", [arg(1), arg(2)]);

    case "==":
      return J.rtCall("_eq", [arg(1), arg(2)]);
    case "!=":
      return J.unary("!", J.rtCall("_eq", [arg(1), arg(2)]));
    case "<":
      return J.binary("<", J.call(J.id("Number"), [arg(1)]), J.call(J.id("Number"), [arg(2)]));
    case ">":
      return J.binary(">", J.call(J.id("Number"), [arg(1)]), J.call(J.id("Number"), [arg(2)]));
    case "<=":
      return J.binary("<=", J.call(J.id("Number"), [arg(1)]), J.call(J.id("Number"), [arg(2)]));
    case ">=":
      return J.binary(">=", J.call(J.id("Number"), [arg(1)]), J.call(J.id("Number"), [arg(2)]));

    case "and":
      return J.binary("&&", arg(1), arg(2));
    case "or":
      return J.binary("||", arg(1), arg(2));
    case "not":
      return J.unary("!", arg(1));

    case "if":
      return J.cond(arg(1), arg(2), arg(3));

    case "do": {
      if (arr.length < 2) throw new CompileError("do requires at least 1 expr", ctx.path);
      const parts = arr.slice(1).map((e, i) => compileExpr(e, childCtx(ctx, i + 1)));
      if (parts.length === 1) return parts[0]!;
      return { t: "seq", exprs: parts };
    }

    case "let": {
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        throw new CompileError("let bindings must be an array", [...ctx.path, 1]);
      }
      const body = arr[2] as Expr;

      // Compile each binding's value in the context with all PRIOR bindings in scope,
      // then add the new binding to the scope for subsequent bindings and the body.
      let currentCtx = pushScope(ctx);
      const bindingData: Array<{ jsName: string; valExpr: JSExpr }> = [];
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          throw new CompileError("each let binding must be [name, expr]", [...ctx.path, 1, i]);
        }
        const name = binding[0];
        if (typeof name !== "string") {
          throw new CompileError("let binding name must be a string", [...ctx.path, 1, i, 0]);
        }
        const valExpr = compileExpr(binding[1] as Expr, {
          ...currentCtx,
          path: childCtx(ctx, i).path,
        });
        const jsName = currentCtx.scope.bind(name);
        bindingData.push({ jsName, valExpr });
      }

      let bodyExpr = compileExpr(body, {
        ...currentCtx,
        path: childCtx(ctx, 2).path,
      });

      // Wrap from innermost outward as IIFEs/arrows
      for (let i = bindingData.length - 1; i >= 0; i--) {
        const { jsName, valExpr } = bindingData[i]!;
        bodyExpr = J.call({ t: "arrow", params: [jsName], body: bodyExpr }, [valExpr]);
      }
      return bodyExpr;
    }

    case "letrec": {
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        throw new CompileError("letrec bindings must be an array", [...ctx.path, 1]);
      }
      const body = arr[2] as Expr;

      const names: string[] = [];
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          throw new CompileError("each letrec binding must be [name, expr]", [...ctx.path, 1, i]);
        }
        const name = binding[0];
        if (typeof name !== "string") {
          throw new CompileError("letrec binding name must be a string", [...ctx.path, 1, i, 0]);
        }
        names.push(name);
      }

      const recCtx = pushScope(ctx);
      const jsNames: string[] = names.map((n) => recCtx.scope.bind(n));

      const stmts: JSStmt[] = [];
      for (const jsName of jsNames) {
        stmts.push({ t: "var", name: jsName });
      }
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i] as Expr[];
        const jsName = jsNames[i]!;
        const valExpr = compileExpr(binding[1] as Expr, recCtx);
        stmts.push({ t: "assign-stmt", lhs: jsName, rhs: valExpr });
      }
      const bodyExpr = compileExpr(body, recCtx);
      stmts.push({ t: "return", expr: bodyExpr });
      return { t: "iife", body: stmts };
    }

    case "fn": {
      const paramsExpr = arr[1];
      if (!Array.isArray(paramsExpr)) {
        throw new CompileError("fn params must be an array", [...ctx.path, 1]);
      }
      const params: string[] = [];
      for (let i = 0; i < paramsExpr.length; i++) {
        const p = paramsExpr[i];
        if (typeof p === "string") {
          params.push(p);
        } else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") {
          params.push(p[0]);
        } else {
          throw new CompileError("fn param must be a string or [name, type] pair", [
            ...ctx.path,
            1,
            i,
          ]);
        }
      }
      const fnCtx = pushScope(ctx);
      const jsParams: string[] = params.map((p) => fnCtx.scope.bind(p));
      const bodyExpr = compileExpr(arr[2] as Expr, {
        ...fnCtx,
        path: childCtx(ctx, 2).path,
        loop: null,
        // fn bodies are arrow functions — yield is invalid inside them.
        inGenerator: false,
        continuationVars: new Set(),
      });
      return {
        t: "arrow",
        params: jsParams,
        body: bodyExpr,
      };
    }

    case "call": {
      const fnE = arg(1);
      const argEs = arr.slice(2).map((e, i) => compileExpr(e, childCtx(ctx, i + 2)));
      // If calling a known continuation variable inside a generator, delegate with yield*.
      const callee = arr[1];
      if (
        ctx.inGenerator &&
        typeof callee === "string" &&
        ctx.continuationVars.has(ctx.scope.resolve(callee) ?? "")
      ) {
        return J.yieldStar(J.call(fnE, argEs));
      }
      return J.call(fnE, argEs);
    }

    case "get":
      return J.rtCall("_get", [arg(1), arg(2)]);
    case "get-in":
      return J.rtCall("_getIn", [arg(1), arg(2)]);
    case "set":
      return J.rtCall("_set", [arg(1), arg(2), arg(3)]);
    case "set-in":
      return J.rtCall("_setIn", [arg(1), arg(2), arg(3)]);
    case "count":
      return J.rtCall("_count", [arg(1)]);
    case "merge":
      return J.rtCall("_merge", [arg(1), arg(2)]);
    case "keys":
      return J.rtCall("_keys", [arg(1)]);
    case "vals":
      return J.rtCall("_vals", [arg(1)]);

    case "array": {
      const elems = arr.slice(1).map((e, i) => compileExpr(e, childCtx(ctx, i + 1)));
      return { t: "array", elems };
    }
    case "array-get":
      return J.rtCall("_arrayGet", [arg(1), arg(2)]);
    case "array-push":
      // Use concat to avoid spread-precedence issues in serialization.
      return J.call(J.member(arg(1), "concat"), [{ t: "array", elems: [arg(2)] }]);
    case "array-slice": {
      if (arr.length === 3) {
        return J.call(J.member(arg(1), "slice"), [J.call(J.id("Number"), [arg(2)])]);
      }
      return J.call(J.member(arg(1), "slice"), [
        J.call(J.id("Number"), [arg(2)]),
        J.call(J.id("Number"), [arg(3)]),
      ]);
    }

    case "record-get":
      return J.rtCall("_get", [arg(1), arg(2)]);
    case "record-set":
      return J.rtCall("_set", [arg(1), arg(2), arg(3)]);
    case "record-del":
      return J.rtCall("_recordDel", [arg(1), arg(2)]);
    case "record-keys":
      return J.rtCall("_keys", [arg(1)]);
    case "record-vals":
      return J.rtCall("_vals", [arg(1)]);
    case "record-merge":
      return J.rtCall("_merge", [arg(1), arg(2)]);

    case "str-len":
      return J.call(J.id("BigInt"), [J.member(arg(1), "length")]);
    case "str-get":
      return J.rtCall("_strGet", [arg(1), arg(2)]);
    case "str-concat":
      return J.binary("+", arg(1), arg(2));
    case "str-slice":
      return J.call(J.member(arg(1), "slice"), [
        J.call(J.id("Number"), [arg(2)]),
        J.call(J.id("Number"), [arg(3)]),
      ]);
    case "str-cmp":
      return J.rtCall("_strCmp", [arg(1), arg(2)]);
    case "parse-int":
      return J.rtCall("_parseInt", [arg(1)]);
    case "parse-float":
      return J.rtCall("_parseFloat", [arg(1)]);

    case "floor":
      return J.rtCall("_floor", [arg(1)]);
    case "ceil":
      return J.rtCall("_ceil", [arg(1)]);
    case "round":
      return J.rtCall("_round", [arg(1)]);
    case "abs":
      return J.rtCall("_abs", [arg(1)]);
    case "min":
      return J.rtCall("_min", [arg(1), arg(2)]);
    case "max":
      return J.rtCall("_max", [arg(1), arg(2)]);
    case "pow":
      return J.call(J.member(J.id("Math"), "pow"), [
        J.call(J.id("Number"), [arg(1)]),
        J.call(J.id("Number"), [arg(2)]),
      ]);
    case "sqrt":
      return J.call(J.member(J.id("Math"), "sqrt"), [J.call(J.id("Number"), [arg(1)])]);
    case "int->float":
      return J.rtCall("_intToFloat", [arg(1)]);
    case "float->int":
      return J.rtCall("_floatToInt", [arg(1)]);

    case "bit-and":
      return J.binary("&", arg(1), arg(2));
    case "bit-or":
      return J.binary("|", arg(1), arg(2));
    case "bit-xor":
      return J.binary("^", arg(1), arg(2));
    case "bit-not":
      return J.rtCall("_bitNot", [arg(1)]);
    case "bit-shl":
      return J.binary("<<", arg(1), arg(2));
    case "bit-shr":
      return J.binary(">>", arg(1), arg(2));

    case "concat": {
      if (arr.length < 2) throw new CompileError("concat requires at least 1 arg", ctx.path);
      const parts = arr.slice(1).map((e, i) => compileExpr(e, childCtx(ctx, i + 1)));
      if (parts.length === 1) return parts[0]!;
      return parts.reduce((acc, p) => J.binary("+", acc, p));
    }

    case "slice":
      return J.rtCall("_slice", [arg(1), arg(2), arg(3)]);
    case "to-string":
      return J.rtCall("_toStr", [arg(1)]);
    case "parse-number":
      return J.rtCall("_parseNum", [arg(1)]);
    case "untyped":
      return arg(1);

    case "match": {
      const scrutE = arg(1);
      const clauses = arr.slice(2);
      const stmts: JSStmt[] = [];
      const scrutName = ctx.scope.gensym("$s");
      stmts.push({ t: "let", name: scrutName, init: scrutE });
      for (let i = 0; i < clauses.length; i++) {
        const clause = clauses[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          throw new CompileError("match clause must be [pattern, body]", [...ctx.path, i + 2]);
        }
        const pattern = clause[0];
        const body = clause[1] as Expr;
        if (!Array.isArray(pattern) || pattern.length < 1) {
          throw new CompileError("match pattern must be an array starting with a tag", [
            ...ctx.path,
            i + 2,
            0,
          ]);
        }
        const tag = pattern[0];
        if (typeof tag !== "string") {
          throw new CompileError("match pattern tag must be a string", [...ctx.path, i + 2, 0]);
        }
        const bindingNames = pattern.slice(1) as string[];
        const bodyCtx = pushScope(ctx);
        const jsBindings: string[] = bindingNames.map((n) => bodyCtx.scope.bind(n));
        const thenStmts: JSStmt[] = [];
        for (let fi = 0; fi < bindingNames.length; fi++) {
          thenStmts.push({
            t: "let",
            name: jsBindings[fi]!,
            init: J.member(J.id(scrutName), `$${fi}`),
          });
        }
        const bodyExpr = compileExpr(body, {
          ...bodyCtx,
          path: childCtx(ctx, i + 2).path,
        });
        thenStmts.push({ t: "return", expr: bodyExpr });
        stmts.push({
          t: "if-stmt",
          test: J.binary("===", J.member(J.id(scrutName), "$tag"), J.lit(JSON.stringify(tag))),
          cons: thenStmts,
        });
      }
      stmts.push({
        t: "throw",
        expr: {
          t: "new",
          ctor: J.id("Error"),
          args: [J.lit(JSON.stringify("non-exhaustive match"))],
        },
      });
      return { t: "iife", body: stmts };
    }

    case "cond": {
      if (arr.length < 2) throw new CompileError("cond requires at least 1 clause", ctx.path);
      const clauses = arr.slice(1);
      let result: JSExpr = {
        t: "iife",
        body: [
          {
            t: "throw",
            expr: {
              t: "new",
              ctor: J.id("Error"),
              args: [J.lit(JSON.stringify("non-exhaustive cond"))],
            },
          },
        ],
      };
      for (let i = clauses.length - 1; i >= 0; i--) {
        const clause = clauses[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          throw new CompileError("cond clause must be [test, expr]", [...ctx.path, i + 1]);
        }
        const test = clause[0];
        const clauseExpr = clause[1] as Expr;
        const exprE = compileExpr(clauseExpr, childCtx(ctx, i + 1));
        if (test === "else") {
          result = exprE;
        } else {
          const testE = compileExpr(test as Expr, childCtx(ctx, i + 1));
          result = J.cond(testE, exprE, result);
        }
      }
      return result;
    }

    case "is": {
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        throw new CompileError("is requires a type name string as first arg", [...ctx.path, 1]);
      }
      return compileIsCheck(typStr, arg(2));
    }

    case "as": {
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        throw new CompileError("as requires a type name string as first arg", [...ctx.path, 1]);
      }
      return J.rtCall("_asCheck", [J.lit(JSON.stringify(typStr)), arg(2)]);
    }

    case "perform": {
      if (!ctx.inGenerator) {
        throw new CompileError(
          "perform cannot be compiled (use interpreter for effects)",
          ctx.path,
        );
      }
      // ["perform", tag, payload]
      const tag = arr[1];
      if (typeof tag !== "string") {
        throw new CompileError("perform tag must be a string literal", ctx.path);
      }
      const payloadExpr = compileExpr(arr[2] as Expr, childCtx(ctx, 2));
      return J.yield(
        J.object([
          ["tag", J.lit(JSON.stringify(tag))],
          ["payload", payloadExpr],
        ]),
      );
    }
    case "handle": {
      if (!ctx.inGenerator) {
        throw new CompileError("handle cannot be compiled (use interpreter for effects)", ctx.path);
      }
      // ["handle", body, clause1, clause2, ..., returnClause?]
      // Effect clause: [["EffectTag", "payloadVar", "kVar"], handlerBody]
      // Return clause: [["return", "resultVar"], returnBody]
      if (arr.length < 2) {
        throw new CompileError("handle requires at least 1 arg", ctx.path);
      }

      type EffectClause = { tag: string; payloadJs: string; kJs: string; body: Expr };
      type ReturnClause = { bindingJs: string; body: Expr };

      const handleCtx = { ...ctx, scope: ctx.scope.child() };
      const effectClauses: EffectClause[] = [];
      let returnClause: ReturnClause | null = null;

      for (let i = 2; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          throw new CompileError("handle clause must be [pattern, body]", [...ctx.path, i]);
        }
        const pattern = clause[0];
        const clauseBody = clause[1] as Expr;
        if (!Array.isArray(pattern) || pattern.length < 1) {
          throw new CompileError("handle clause pattern must be an array", [...ctx.path, i, 0]);
        }
        const tag = pattern[0];
        if (typeof tag !== "string") {
          throw new CompileError("handle clause tag must be a string", [...ctx.path, i, 0]);
        }
        if (tag === "return") {
          if (pattern.length !== 2 || typeof pattern[1] !== "string") {
            throw new CompileError('return clause must be ["return", bindingName]', [
              ...ctx.path,
              i,
              0,
            ]);
          }
          const bindingJs = handleCtx.scope.bind(pattern[1] as string);
          returnClause = { bindingJs, body: clauseBody };
        } else {
          if (
            pattern.length !== 3 ||
            typeof pattern[1] !== "string" ||
            typeof pattern[2] !== "string"
          ) {
            throw new CompileError('effect clause must be ["Tag", payloadBinding, kBinding]', [
              ...ctx.path,
              i,
              0,
            ]);
          }
          const payloadJs = handleCtx.scope.bind(pattern[1] as string);
          const kJs = handleCtx.scope.bind(pattern[2] as string);
          effectClauses.push({ tag, payloadJs, kJs, body: clauseBody });
        }
      }

      // Generate internal names
      const genName = handleCtx.scope.gensym("_gen");
      const dispatchName = handleCtx.scope.gensym("_dispatch");
      const stepName = handleCtx.scope.gensym("_step");
      const effName = handleCtx.scope.gensym("_eff");
      const resumeName = handleCtx.scope.gensym("_resume");

      // Compile body with inGenerator: true
      const bodyIr = compileExpr(arr[1] as Expr, { ...handleCtx, path: childCtx(ctx, 1).path });
      const bodySrc = serializeExpr(bodyIr);

      // Build continuation vars set for handler bodies (they can call k)
      const kNames = new Set(effectClauses.map((c) => c.kJs));
      const handlerBodyCtx: CompileCtx = {
        ...handleCtx,
        inGenerator: true,
        continuationVars: new Set([...ctx.continuationVars, ...kNames]),
      };

      // Build _dispatch function body statements as JS source
      // We build this as raw statements inside a function* body
      const dispatchBodyStmts: string[] = [];

      // while (!_step.done) { ... }
      const whileBody: string[] = [];
      whileBody.push(`const ${effName} = ${stepName}.value;`);

      for (const clause of effectClauses) {
        const { tag, payloadJs, kJs, body: handlerBody } = clause;
        const handlerIr = compileExpr(handlerBody, {
          ...handlerBodyCtx,
          path: [...ctx.path, arr.indexOf(handlerBody)],
        });
        const handlerSrc = serializeExpr(handlerIr);
        whileBody.push(
          `if (${effName}.tag === ${JSON.stringify(tag)}) {` +
            `const ${payloadJs} = ${effName}.payload;` +
            `const ${kJs} = (_rv) => ${dispatchName}(${genName}.next(_rv));` +
            `return yield* (function*() { return (${handlerSrc}); })();` +
            `}`,
        );
      }
      // Propagate unhandled effects
      whileBody.push(
        `const ${resumeName} = (yield ${effName});` +
          `${stepName} = ${genName}.next(${resumeName});`,
      );

      dispatchBodyStmts.push(`while (!${stepName}.done) { ${whileBody.join(" ")} }`);

      // Return clause (after while)
      if (returnClause) {
        const { bindingJs, body: retBody } = returnClause;
        const retIr = compileExpr(retBody, { ...handlerBodyCtx, path: [...ctx.path] });
        const retSrc = serializeExpr(retIr);
        dispatchBodyStmts.push(
          `const ${bindingJs} = ${stepName}.value;` +
            `return yield* (function*() { return (${retSrc}); })();`,
        );
      } else {
        dispatchBodyStmts.push(`return ${stepName}.value;`);
      }

      // Build the handle as a yield*-delegated generator IIFE.
      // Must be a function* (not arrow) so that yield* and yield inside are valid.
      const iifeSrc =
        `(yield* (function*() {` +
        `const ${genName} = (function*() { return (${bodySrc}); })();` +
        `function* ${dispatchName}(${stepName}) { ${dispatchBodyStmts.join(" ")} }` +
        `return yield* ${dispatchName}(${genName}.next());` +
        `})())`;

      return J.lit(iifeSrc);
    }

    case "__native": {
      const name = arr[1];
      if (typeof name !== "string") {
        throw new CompileError("__native: first arg must be a function name string", ctx.path);
      }
      const argEs = arr.slice(2).map((e, i) => compileExpr(e as Expr, childCtx(ctx, i + 2)));
      return J.call(J.member(J.id("_nat"), name), argEs);
    }

    case "__lit": {
      if (arr.length !== 2) {
        throw new CompileError("__lit: requires exactly one argument", ctx.path);
      }
      return J.lit(serializeLit(arr[1]));
    }

    case "__loop": {
      // ["__loop", params, initArgs, body] → labeled while loop in an IIFE.
      // Body is compiled in tail-statement mode so __continue can emit a real
      // `continue label;` without crossing a function boundary.
      const params = arr[1];
      const initArgs = arr[2];
      const body = arr[3] as Expr;
      if (!Array.isArray(params) || !Array.isArray(initArgs)) {
        throw new CompileError("__loop: params and initArgs must be arrays", ctx.path);
      }
      if (params.length !== initArgs.length) {
        throw new CompileError("__loop: params and initArgs must have the same length", ctx.path);
      }
      const paramNames: string[] = [];
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (typeof p !== "string") {
          throw new CompileError("__loop: param names must be strings", ctx.path);
        }
        paramNames.push(p);
      }
      const initEs = (initArgs as Expr[]).map((e, i) => compileExpr(e, childCtx(ctx, i + 2)));

      const loopScopeCtx = pushScope(ctx);
      const jsParams: string[] = paramNames.map((p) => loopScopeCtx.scope.bind(p));
      const label = loopScopeCtx.scope.gensym(`_L${ctx.loopCounter.n++}`);
      const bodyCtx: CompileCtx = {
        ...loopScopeCtx,
        path: childCtx(ctx, 3).path,
        loop: { params: jsParams, label },
      };
      const bodyStmts = compileTail(body, bodyCtx);

      // Stmts: let p1 = init1; ...; label: while(true) { ...bodyStmts }
      const stmts: JSStmt[] = [];
      for (let i = 0; i < jsParams.length; i++) {
        stmts.push({ t: "let", name: jsParams[i]!, init: initEs[i]! });
      }
      stmts.push({
        t: "while",
        label,
        body: bodyStmts,
      });
      return { t: "iife", body: stmts };
    }

    case "__continue": {
      // __continue can only appear in tail position (handled by compileTail).
      // If we reach here in expression context, that's an error — though the
      // value is never used, we still need to remain semantically valid.
      // The check ensures it's only used inside a __loop.
      if (ctx.loop === null) {
        throw new CompileError("__continue outside __loop", ctx.path);
      }
      // Emit a (dead) expression that, if ever reached as a value, throws.
      // In practice compileTail intercepts __continue before this is hit.
      throw new CompileError("__continue must appear in tail position of __loop body", ctx.path);
    }

    default:
      throw new CompileError(`unknown op: ${op}`, ctx.path);
  }
}

// Compile in tail-statement position: result becomes either `return expr;` or,
// for __continue, a sequence of assignments + `continue label;`.
// Used inside __loop bodies so __continue emits real labeled-continue without
// crossing any function boundary.
function compileTail(expr: Expr, ctx: CompileCtx): JSStmt[] {
  // Atoms / variable refs / ops other than control-flow ones fall through to
  // expression compilation wrapped in a return.
  if (
    expr === null ||
    typeof expr === "boolean" ||
    typeof expr === "number" ||
    typeof expr === "string"
  ) {
    return [{ t: "return", expr: compileExpr(expr, ctx) }];
  }
  const arr = expr as Expr[];
  if (arr.length === 0) {
    return [{ t: "return", expr: compileExpr(expr, ctx) }];
  }
  const opExpr = arr[0];
  if (typeof opExpr !== "string") {
    return [{ t: "return", expr: compileExpr(expr, ctx) }];
  }
  const op = opExpr;

  switch (op) {
    case "__continue": {
      if (ctx.loop === null) {
        throw new CompileError("__continue outside __loop", ctx.path);
      }
      const loop = ctx.loop;
      const newArgEs = arr.slice(1).map((e, i) => compileExpr(e as Expr, childCtx(ctx, i + 1)));
      if (newArgEs.length !== loop.params.length) {
        throw new CompileError(
          `__continue: expected ${loop.params.length} args, got ${newArgEs.length}`,
          ctx.path,
        );
      }
      // Evaluate args into temporaries first to avoid aliasing with loop params.
      const stmts: JSStmt[] = [];
      const tmpNames: string[] = [];
      for (let i = 0; i < newArgEs.length; i++) {
        const tmp = ctx.scope.gensym(`$c${ctx.loopCounter.n}_${i}`);
        tmpNames.push(tmp);
        stmts.push({ t: "let", name: tmp, init: newArgEs[i]! });
      }
      for (let i = 0; i < loop.params.length; i++) {
        stmts.push({
          t: "assign-stmt",
          lhs: loop.params[i]!,
          rhs: J.id(tmpNames[i]!),
        });
      }
      stmts.push({ t: "continue", label: loop.label });
      return stmts;
    }

    case "if": {
      if (arr.length !== 4) {
        return [{ t: "return", expr: compileExpr(expr, ctx) }];
      }
      const testE = compileExpr(arr[1] as Expr, childCtx(ctx, 1));
      const thenStmts = compileTail(arr[2] as Expr, childCtx(ctx, 2));
      const elseStmts = compileTail(arr[3] as Expr, childCtx(ctx, 3));
      return [{ t: "if-stmt", test: testE, cons: thenStmts, else: elseStmts }];
    }

    case "do": {
      if (arr.length < 2) {
        return [{ t: "return", expr: compileExpr(expr, ctx) }];
      }
      const stmts: JSStmt[] = [];
      for (let i = 1; i < arr.length - 1; i++) {
        stmts.push({
          t: "expr",
          expr: compileExpr(arr[i] as Expr, childCtx(ctx, i)),
        });
      }
      const tail = compileTail(arr[arr.length - 1] as Expr, childCtx(ctx, arr.length - 1));
      return [...stmts, ...tail];
    }

    case "let": {
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        return [{ t: "return", expr: compileExpr(expr, ctx) }];
      }
      const body = arr[2] as Expr;
      const stmts: JSStmt[] = [];
      let currentCtx = pushScope(ctx);
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          throw new CompileError("each let binding must be [name, expr]", [...ctx.path, 1, i]);
        }
        const name = binding[0];
        if (typeof name !== "string") {
          throw new CompileError("let binding name must be a string", [...ctx.path, 1, i, 0]);
        }
        const valExpr = compileExpr(binding[1] as Expr, {
          ...currentCtx,
          path: childCtx(ctx, i).path,
        });
        const jsName = currentCtx.scope.bind(name);
        stmts.push({ t: "let", name: jsName, init: valExpr });
      }
      const tail = compileTail(body, {
        ...currentCtx,
        path: childCtx(ctx, 2).path,
      });
      // Wrap in a block so `let` declarations don't leak across iterations.
      return [{ t: "block", stmts: [...stmts, ...tail] }];
    }

    case "cond": {
      if (arr.length < 2) {
        return [{ t: "return", expr: compileExpr(expr, ctx) }];
      }
      const clauses = arr.slice(1);
      // Build from end: start with non-exhaustive throw, wrap in if-stmt's.
      let elseBranch: JSStmt[] = [
        {
          t: "throw",
          expr: {
            t: "new",
            ctor: J.id("Error"),
            args: [J.lit(JSON.stringify("non-exhaustive cond"))],
          },
        },
      ];
      for (let i = clauses.length - 1; i >= 0; i--) {
        const clause = clauses[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          throw new CompileError("cond clause must be [test, expr]", [...ctx.path, i + 1]);
        }
        const test = clause[0];
        const clauseExpr = clause[1] as Expr;
        const branch = compileTail(clauseExpr, childCtx(ctx, i + 1));
        if (test === "else") {
          elseBranch = branch;
        } else {
          const testE = compileExpr(test as Expr, childCtx(ctx, i + 1));
          elseBranch = [{ t: "if-stmt", test: testE, cons: branch, else: elseBranch }];
        }
      }
      return elseBranch;
    }

    case "match": {
      if (arr.length < 2) {
        return [{ t: "return", expr: compileExpr(expr, ctx) }];
      }
      const scrutE = compileExpr(arr[1] as Expr, childCtx(ctx, 1));
      const clauses = arr.slice(2);
      const scrutName = ctx.scope.gensym(`$s${ctx.loopCounter.n}`);
      const stmts: JSStmt[] = [{ t: "let", name: scrutName, init: scrutE }];
      for (let i = 0; i < clauses.length; i++) {
        const clause = clauses[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          throw new CompileError("match clause must be [pattern, body]", [...ctx.path, i + 2]);
        }
        const pattern = clause[0];
        const body = clause[1] as Expr;
        if (!Array.isArray(pattern) || pattern.length < 1) {
          throw new CompileError("match pattern must be an array starting with a tag", [
            ...ctx.path,
            i + 2,
            0,
          ]);
        }
        const tag = pattern[0];
        if (typeof tag !== "string") {
          throw new CompileError("match pattern tag must be a string", [...ctx.path, i + 2, 0]);
        }
        const bindingNames = pattern.slice(1) as string[];
        const bodyCtx = pushScope(ctx);
        const jsBindings: string[] = bindingNames.map((n) => bodyCtx.scope.bind(n));
        const thenStmts: JSStmt[] = [];
        for (let fi = 0; fi < bindingNames.length; fi++) {
          thenStmts.push({
            t: "let",
            name: jsBindings[fi]!,
            init: J.member(J.id(scrutName), `$${fi}`),
          });
        }
        const tail = compileTail(body, {
          ...bodyCtx,
          path: childCtx(ctx, i + 2).path,
        });
        thenStmts.push(...tail);
        stmts.push({
          t: "if-stmt",
          test: J.binary("===", J.member(J.id(scrutName), "$tag"), J.lit(JSON.stringify(tag))),
          cons: thenStmts,
        });
      }
      stmts.push({
        t: "throw",
        expr: {
          t: "new",
          ctor: J.id("Error"),
          args: [J.lit(JSON.stringify("non-exhaustive match"))],
        },
      });
      return [{ t: "block", stmts }];
    }

    default:
      return [{ t: "return", expr: compileExpr(expr, ctx) }];
  }
}

function compileIsCheck(typStr: string, val: JSExpr): JSExpr {
  switch (typStr) {
    case "null":
      return J.binary("===", val, J.lit("null"));
    case "bool":
    case "boolean":
      return J.binary("===", J.unary("typeof ", val), J.lit('"boolean"'));
    case "int":
      return J.binary("===", J.unary("typeof ", val), J.lit('"bigint"'));
    case "float":
      return J.binary("===", J.unary("typeof ", val), J.lit('"number"'));
    case "number":
      return J.binary(
        "||",
        J.binary("===", J.unary("typeof ", val), J.lit('"bigint"')),
        J.binary("===", J.unary("typeof ", val), J.lit('"number"')),
      );
    case "string":
      return J.binary("===", J.unary("typeof ", val), J.lit('"string"'));
    case "array":
      return J.call(J.member(J.id("Array"), "isArray"), [val]);
    case "record":
      return J.binary(
        "&&",
        J.binary(
          "&&",
          J.binary("!==", val, J.lit("null")),
          J.binary("===", J.unary("typeof ", val), J.lit('"object"')),
        ),
        J.unary("!", J.call(J.member(J.id("Array"), "isArray"), [val])),
      );
    case "variant":
      return J.binary(
        "&&",
        J.binary(
          "&&",
          J.binary("!==", val, J.lit("null")),
          J.binary("===", J.unary("typeof ", val), J.lit('"object"')),
        ),
        J.binary("===", J.unary("typeof ", J.member(val, "$tag")), J.lit('"string"')),
      );
    default:
      return J.lit("false");
  }
}

// Options for compilation.
export type CompileOptions = {
  /** When true (default), run constant-folding optimizer before code generation. */
  optimize?: boolean;
  /** Optional type/effect info, used by purity-gated optimizer passes (e.g. loop fusion).
   * Must be built from the same expression passed to compile(). */
  typeInfo?: TypeInfo;
};

/** Internal: compile an already-prepared expression (no optimization step). */
function compileRaw(expr: Expr): JitFn {
  const body = compileExpr(expr, emptyCtx());
  const src = serializeExpr(body);
  // eslint-disable-next-line no-new-func
  const raw = new Function("env", "_rt", "_nat", `return (${src})`);
  return (env: Record<string, unknown>) => raw(env, RUNTIME, NATIVES);
}

/** Run all enabled optimizer passes in pipeline order. */
function runOptimizer(expr: Expr, typeInfo?: TypeInfo): Expr {
  // Phase 4: tail-call optimization — convert tail-recursive letrec forms
  // into `__loop` / `__continue` nodes. Runs before constant folding so
  // subsequent passes see a normalized loop shape.
  let e = tco(expr);
  // Phase 1+2: constant folding + dead-binding elimination + literal copy
  // propagation, all expressed as rewrite rules.
  e = optimize(e, CONSTANT_FOLDING_RULES);
  // Phase 6: inline small, non-looping, single-use functions.
  e = inlineSmallFunctions(e);
  // Phase 5a: loop pattern recognition — replace `__loop` nodes that match
  // known shapes (array-map / array-filter / array-reduce / ...) with
  // `__native` invocations.
  e = recognizeLoopPatterns(e);
  // Phase 5b: loop fusion — fuse adjacent pure `__native` array operations
  // into single-pass equivalents. Gated on TypeInfo's purity check; without
  // TypeInfo, this is a no-op.
  e = fuseLoops(e, typeInfo);
  // Re-run constant folding so newly-inlined / recognized / fused expressions
  // get folded.
  e = optimize(e, CONSTANT_FOLDING_RULES);
  return e;
}

/** Internal: render an expression to its generated JS source (for tests/inspection). */
export function compileToSource(expr: Expr, opts: CompileOptions = {}): string {
  const e = opts.optimize === false ? expr : runOptimizer(expr, opts.typeInfo);
  return serializeExpr(compileExpr(e, emptyCtx()));
}

// Compile a Marinada expression to a native JS function.
// Throws CompileError if the expression cannot be compiled (e.g. uses effects).
// By default, runs the constant-folding optimizer first; pass `{ optimize: false }`
// to skip it (useful for tests that want to inspect un-optimized code shape).
export function compile(expr: Expr, opts: CompileOptions = {}): JitFn {
  const e = opts.optimize === false ? expr : runOptimizer(expr, opts.typeInfo);
  return compileRaw(e);
}

// A compiled effectful Marinada expression.
// Takes an env and returns a generator that yields Effects and returns a value.
export type JitEffectfulFn = (env: Record<string, unknown>) => Generator<Effect, unknown, unknown>;

/** Internal: compile an already-prepared effectful expression (no optimization step). */
function compileEffectfulRaw(expr: Expr): JitEffectfulFn {
  const ir = compileExpr(expr, { ...emptyCtx(), inGenerator: true });
  const src = serializeExpr(ir);
  // Wrap in function* so yield nodes inside the expression are valid.
  // eslint-disable-next-line no-new-func
  const raw = new Function("env", "_rt", "_nat", `return (function*() { return (${src}); })();`);
  return (env: Record<string, unknown>) =>
    raw(env, RUNTIME, NATIVES) as Generator<Effect, unknown, unknown>;
}

/** Compile a Marinada expression containing effects to a generator-based function.
 * The generator yields Effect objects upward and receives resume values, identical
 * to the interpreter's evalGen protocol.
 *
 * Unlike compile(), this does NOT throw on perform/handle — those are handled
 * in the generator protocol. */
export function compileEffectful(expr: Expr, opts: CompileOptions = {}): JitEffectfulFn {
  return compileEffectfulRaw(opts.optimize === false ? expr : runOptimizer(expr, opts.typeInfo));
}

/** Compile with constant folding explicitly enabled. Identical to `compile()` default;
 * exported for symmetry with explicit opt-out. */
export function compileOptimized(expr: Expr): JitFn {
  return compile(expr, { optimize: true });
}
