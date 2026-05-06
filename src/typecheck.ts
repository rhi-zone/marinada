import type { Expr, Module, TypeDef } from "./types.ts";
import { libStdResolver } from "./resolvers.ts";

// ---------------------------------------------------------------------------
// MType — Hindley-Milner monotypes plus a few non-HM extras carried through.
// ---------------------------------------------------------------------------

export type MType =
  | { kind: "var"; id: number }
  | { kind: "unknown" }
  | { kind: "null" }
  | { kind: "bool" }
  | { kind: "int" }
  | { kind: "float" }
  | { kind: "string" }
  | { kind: "bytes" }
  | { kind: "array"; elem: MType }
  | { kind: "row"; fields: Map<string, MType>; rest: number | "empty" }
  | { kind: "record"; row: MType }
  | { kind: "fn"; params: MType[]; ret: MType; effects?: MType }
  | { kind: "linear"; inner: MType }
  | { kind: "affine"; inner: MType }
  | { kind: "variant"; tag: string; fields: MType[] }
  | { kind: "named"; name: string; args: MType[] }
  | { kind: "scheme"; quantified: number[]; body: MType };

// ---------------------------------------------------------------------------
// Type definitions (DUs)
// ---------------------------------------------------------------------------

/**
 * A type definition: a parameterised DU. Variants map tag → list of field types,
 * where any free type vars in those types come from `params` (one fresh var
 * is allocated per param at instantiation time).
 */
export type TypeDefInfo = {
  /** Type parameter names, in order. */
  params: string[];
  /** Variants. Each variant has a list of field types referencing params. */
  variants: Map<string, MType[]>;
};

// Singletons for atomic types
const UNKNOWN: MType = { kind: "unknown" };
const NULL_T: MType = { kind: "null" };
const BOOL: MType = { kind: "bool" };
const INT: MType = { kind: "int" };
const FLOAT: MType = { kind: "float" };
const STRING: MType = { kind: "string" };
const BYTES: MType = { kind: "bytes" };

// ---------------------------------------------------------------------------
// Substitution + fresh var supply
// ---------------------------------------------------------------------------

type Substitution = Map<number, MType>;

class State {
  readonly subst: Substitution = new Map();
  private nextId = 0;
  freshVar(): MType {
    return { kind: "var", id: this.nextId++ };
  }
  freshId(): number {
    return this.nextId++;
  }
}

/** Walk substitution chain. Returns the underlying type with var ids mapped. */
function find(t: MType, subst: Substitution): MType {
  let cur = t;
  while (cur.kind === "var") {
    const next = subst.get(cur.id);
    if (next === undefined) return cur;
    cur = next;
  }
  return cur;
}

/** Resolve a row's tail through the substitution. Used when iterating row fields. */
function resolveRow(t: MType, subst: Substitution): MType {
  let cur = find(t, subst);
  while (cur.kind === "row" && typeof cur.rest === "number") {
    const next = subst.get(cur.rest);
    if (next === undefined) return cur;
    const nextR = find(next, subst);
    if (nextR.kind !== "row") {
      // tail bound to a non-row (e.g. another var) — leave as is
      return cur;
    }
    // Merge: combine fields with tail's fields. Local wins in case of duplicates
    // (caller must ensure no duplicates via row unification).
    const merged = new Map<string, MType>(nextR.fields);
    for (const [k, v] of cur.fields) merged.set(k, v);
    cur = { kind: "row", fields: merged, rest: nextR.rest };
  }
  return cur;
}

/** Fully resolve type by substituting recursively. Pure; does not mutate. */
function zonk(t: MType, subst: Substitution): MType {
  const r = find(t, subst);
  switch (r.kind) {
    case "var":
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
      return r;
    case "named":
      return {
        kind: "named",
        name: r.name,
        args: r.args.map((a) => zonk(a, subst)),
      };
    case "array":
      return { kind: "array", elem: zonk(r.elem, subst) };
    case "row": {
      const flat = resolveRow(r, subst);
      if (flat.kind !== "row") return zonk(flat, subst);
      const fields = new Map<string, MType>();
      for (const [k, v] of flat.fields) fields.set(k, zonk(v, subst));
      return { kind: "row", fields, rest: flat.rest };
    }
    case "record":
      return { kind: "record", row: zonk(r.row, subst) };
    case "fn":
      return {
        kind: "fn",
        params: r.params.map((p) => zonk(p, subst)),
        ret: zonk(r.ret, subst),
        effects: zonk(fnEffects(r), subst),
      };
    case "linear":
      return { kind: "linear", inner: zonk(r.inner, subst) };
    case "affine":
      return { kind: "affine", inner: zonk(r.inner, subst) };
    case "variant":
      return {
        kind: "variant",
        tag: r.tag,
        fields: r.fields.map((f) => zonk(f, subst)),
      };
    case "scheme":
      return {
        kind: "scheme",
        quantified: r.quantified,
        body: zonk(r.body, subst),
      };
  }
}

// ---------------------------------------------------------------------------
// Free type variables (after substitution)
// ---------------------------------------------------------------------------

function ftv(t: MType, subst: Substitution, out: Set<number>): void {
  const r = find(t, subst);
  switch (r.kind) {
    case "var":
      out.add(r.id);
      return;
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
      return;
    case "named":
      for (const a of r.args) ftv(a, subst, out);
      return;
    case "array":
      ftv(r.elem, subst, out);
      return;
    case "row": {
      const flat = resolveRow(r, subst);
      if (flat.kind !== "row") {
        ftv(flat, subst, out);
        return;
      }
      for (const v of flat.fields.values()) ftv(v, subst, out);
      if (typeof flat.rest === "number") {
        // The tail var, if unbound, is free.
        const tailVar: MType = { kind: "var", id: flat.rest };
        const tr = find(tailVar, subst);
        if (tr.kind === "var") out.add(tr.id);
        else ftv(tr, subst, out);
      }
      return;
    }
    case "record":
      ftv(r.row, subst, out);
      return;
    case "fn":
      for (const p of r.params) ftv(p, subst, out);
      ftv(r.ret, subst, out);
      ftv(fnEffects(r), subst, out);
      return;
    case "linear":
    case "affine":
      ftv(r.inner, subst, out);
      return;
    case "variant":
      for (const f of r.fields) ftv(f, subst, out);
      return;
    case "scheme": {
      const inner = new Set<number>();
      ftv(r.body, subst, inner);
      for (const q of r.quantified) inner.delete(q);
      for (const id of inner) out.add(id);
      return;
    }
  }
}

function ftvOfEnv(env: TypeEnv, subst: Substitution): Set<number> {
  const out = new Set<number>();
  for (const t of env.allBindings()) ftv(t, subst, out);
  return out;
}

// ---------------------------------------------------------------------------
// TypeEnv
// ---------------------------------------------------------------------------

export class TypeEnv {
  private readonly bindings: Map<string, MType>;
  private readonly parent: TypeEnv | null;

  constructor(bindings: Map<string, MType> = new Map(), parent: TypeEnv | null = null) {
    this.bindings = bindings;
    this.parent = parent;
  }

  lookup(name: string): MType | undefined {
    const t = this.bindings.get(name);
    if (t !== undefined) return t;
    return this.parent?.lookup(name);
  }

  extend(bindings: Record<string, MType>): TypeEnv {
    return new TypeEnv(new Map(Object.entries(bindings)), this);
  }

  set(name: string, t: MType): void {
    this.bindings.set(name, t);
  }

  *allBindings(): IterableIterator<MType> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let e: TypeEnv | null = this;
    while (e !== null) {
      for (const t of e.bindings.values()) yield t;
      e = e.parent;
    }
  }
}

export const EMPTY_TYPE_ENV = new TypeEnv();

// ---------------------------------------------------------------------------
// Errors / result
// ---------------------------------------------------------------------------

export type TypecheckError = {
  code: string;
  path: number[];
  message: string;
  expected?: string;
  got?: string;
  suggestion?: string;
};

export type TypecheckResult =
  | { ok: true; type: MType; exports?: Map<string, MType> }
  | { ok: false; errors: TypecheckError[] };

/** Signature for an algebraic effect: payload type and resume type. */
export type EffectSig = { payload: MType; resume: MType };

/**
 * Method signature on a capability. Built-in caps (Network, Storage) have
 * fully-typed methods; plugin-defined caps are unknown to the type checker
 * and fall back to `unknown` returns. Each method declares an effect tag
 * that gets added to the ambient effect row at the call site.
 *
 * NOTE: capabilities are `linear` by default per spec — but linearity is
 * not enforced here. Phase 6 will add the linearity checker.
 */
export type CapMethodSig = { params: MType[]; ret: MType; effect: string };

type Ctx = {
  errors: TypecheckError[];
  path: number[];
  state: State;
  /** Type definition table — keyed by type name (e.g. "option", "Shape"). */
  typeDefs: Map<string, TypeDefInfo>;
  /** Constructor index: tag → declaring type name. */
  ctors: Map<string, string>;
  /** Effect signatures table — keyed by effect tag (e.g. "Error", "Async"). */
  effectSigs: Map<string, EffectSig>;
  /**
   * Capability method tables — keyed by cap-interface name (e.g. "Network",
   * "Storage"). Each entry maps method name → signature. Plugin-defined caps
   * not present here fall back to `unknown` returns.
   */
  capMethods: Map<string, Map<string, CapMethodSig>>;
  /**
   * The effect row that the currently-being-inferred expression contributes
   * to. `perform` and `call` extend this; `fn` saves/restores it; `handle`
   * pops handled tags off the inner row and propagates the rest.
   *
   * Always a row type. When a sub-expression's effects need to be added, we
   * unify the sub-effect row with this row (sharing tails so accumulation
   * works).
   */
  currentEffects: MType;
  /**
   * Optional per-node type index for buildTypeInfo. When present, `infer`
   * records the inferred type and the effect row snapshot at each path.
   */
  typeIndex?: Map<string, { type: MType; effectsRowId: MType }>;
};

function addError(
  ctx: Ctx,
  code: string,
  message: string,
  extras?: { expected?: string; got?: string; suggestion?: string },
): void {
  ctx.errors.push({ code, path: [...ctx.path], message, ...extras });
}

function withPath<T>(ctx: Ctx, idx: number, fn: (sub: Ctx) => T): T {
  const sub: Ctx = {
    errors: ctx.errors,
    path: [...ctx.path, idx],
    state: ctx.state,
    typeDefs: ctx.typeDefs,
    ctors: ctx.ctors,
    effectSigs: ctx.effectSigs,
    capMethods: ctx.capMethods,
    currentEffects: ctx.currentEffects,
    ...(ctx.typeIndex !== undefined ? { typeIndex: ctx.typeIndex } : {}),
  };
  return fn(sub);
}

function at(arr: Expr[], i: number): Expr {
  return arr[i] as Expr;
}

// ---------------------------------------------------------------------------
// Type rendering
// ---------------------------------------------------------------------------

function typeName(t: MType): string {
  switch (t.kind) {
    case "var":
      return "t" + String(t.id);
    case "unknown":
      return "unknown";
    case "null":
      return "null";
    case "bool":
      return "bool";
    case "int":
      return "int";
    case "float":
      return "float";
    case "string":
      return "string";
    case "bytes":
      return "bytes";
    case "array":
      return "array<" + typeName(t.elem) + ">";
    case "row": {
      const parts: string[] = [];
      for (const [k, v] of t.fields) parts.push(k + ": " + typeName(v));
      if (typeof t.rest === "number") parts.push("...r" + String(t.rest));
      return "{" + parts.join(", ") + "}";
    }
    case "record":
      return "record" + typeName(t.row);
    case "fn": {
      const base = "fn(" + t.params.map(typeName).join(", ") + ") -> " + typeName(t.ret);
      const eff = t.effects;
      if (eff === undefined) return base;
      if (eff.kind === "row" && eff.fields.size === 0 && eff.rest === "empty") return base;
      return base + " ! " + typeName(eff);
    }
    case "linear":
      return "linear " + typeName(t.inner);
    case "affine":
      return "affine " + typeName(t.inner);
    case "variant":
      return t.fields.length === 0 ? t.tag : t.tag + "(" + t.fields.map(typeName).join(", ") + ")";
    case "named":
      return t.args.length === 0 ? t.name : t.name + "<" + t.args.map(typeName).join(", ") + ">";
    case "scheme":
      return (
        "forall " + t.quantified.map((id) => "t" + String(id)).join(",") + ". " + typeName(t.body)
      );
  }
}

/** Pretty-print a type for stable test assertions. */
export function prettyType(t: MType): string {
  const seen = new Map<number, string>();
  let nextChar = 0;
  function name(id: number): string {
    const existing = seen.get(id);
    if (existing !== undefined) return existing;
    const n = nextChar++;
    const letter = String.fromCharCode("a".charCodeAt(0) + (n % 26));
    const suffix = n >= 26 ? String(Math.floor(n / 26)) : "";
    const fresh = letter + suffix;
    seen.set(id, fresh);
    return fresh;
  }
  function go(t: MType): string {
    switch (t.kind) {
      case "var":
        return name(t.id);
      case "unknown":
        return "unknown";
      case "null":
        return "null";
      case "bool":
        return "bool";
      case "int":
        return "int";
      case "float":
        return "float";
      case "string":
        return "string";
      case "bytes":
        return "bytes";
      case "array":
        return "array<" + go(t.elem) + ">";
      case "row": {
        const parts: string[] = [];
        const sortedKeys = [...t.fields.keys()].sort();
        for (const k of sortedKeys) parts.push(k + ": " + go(t.fields.get(k) as MType));
        if (typeof t.rest === "number") {
          return "{" + parts.join(", ") + " | " + name(t.rest) + "}";
        }
        return "{" + parts.join(", ") + "}";
      }
      case "record":
        return go(t.row);
      case "fn": {
        const base = "fn(" + t.params.map(go).join(", ") + ") -> " + go(t.ret);
        const eff = t.effects;
        if (eff === undefined) return base;
        // Suppress the effect annotation when the row is statically pure
        // (closed and empty). Open rows with no fields are also suppressed —
        // they add no information beyond what a pure function already implies
        // for HM unification at use-sites.
        if (eff.kind === "row" && eff.fields.size === 0) {
          if (eff.rest === "empty") return base;
          return base;
        }
        return base + " ! " + go(eff);
      }
      case "linear":
        return "linear " + go(t.inner);
      case "affine":
        return "affine " + go(t.inner);
      case "variant":
        return t.fields.length === 0 ? t.tag : t.tag + "(" + t.fields.map(go).join(", ") + ")";
      case "named":
        return t.args.length === 0 ? t.name : t.name + "<" + t.args.map(go).join(", ") + ">";
      case "scheme":
        return "forall " + t.quantified.map((id) => name(id)).join(",") + ". " + go(t.body);
    }
  }
  return go(t);
}

// ---------------------------------------------------------------------------
// Occurs check + unification
// ---------------------------------------------------------------------------

function occurs(id: number, t: MType, subst: Substitution): boolean {
  const r = find(t, subst);
  switch (r.kind) {
    case "var":
      return r.id === id;
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
      return false;
    case "named":
      for (const a of r.args) if (occurs(id, a, subst)) return true;
      return false;
    case "array":
      return occurs(id, r.elem, subst);
    case "row": {
      const flat = resolveRow(r, subst);
      if (flat.kind !== "row") return occurs(id, flat, subst);
      for (const v of flat.fields.values()) if (occurs(id, v, subst)) return true;
      if (typeof flat.rest === "number") {
        if (flat.rest === id) return true;
        const tr = find({ kind: "var", id: flat.rest }, subst);
        if (tr.kind !== "var") return occurs(id, tr, subst);
      }
      return false;
    }
    case "record":
      return occurs(id, r.row, subst);
    case "fn":
      for (const p of r.params) if (occurs(id, p, subst)) return true;
      if (occurs(id, r.ret, subst)) return true;
      return occurs(id, fnEffects(r), subst);
    case "linear":
    case "affine":
      return occurs(id, r.inner, subst);
    case "variant":
      for (const f of r.fields) if (occurs(id, f, subst)) return true;
      return false;
    case "scheme":
      return occurs(id, r.body, subst);
  }
}

type UnifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Unify two types eagerly. Mutates the substitution.
 *
 * Gradual typing: `unknown` consistent-unifies with anything silently.
 */
function unify(a: MType, b: MType, subst: Substitution, state: State): UnifyResult {
  const ra = find(a, subst);
  const rb = find(b, subst);

  if (ra.kind === "unknown" || rb.kind === "unknown") return { ok: true };

  if (ra.kind === "var") {
    if (rb.kind === "var" && ra.id === rb.id) return { ok: true };
    if (occurs(ra.id, rb, subst)) return { ok: false, reason: "occurs check failed" };
    subst.set(ra.id, rb);
    return { ok: true };
  }
  if (rb.kind === "var") {
    if (occurs(rb.id, ra, subst)) return { ok: false, reason: "occurs check failed" };
    subst.set(rb.id, ra);
    return { ok: true };
  }

  if (ra.kind !== rb.kind) {
    return { ok: false, reason: typeName(ra) + " vs " + typeName(rb) };
  }

  switch (ra.kind) {
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
      return { ok: true };
    case "named": {
      const nb = rb as { kind: "named"; name: string; args: MType[] };
      if (ra.name !== nb.name) {
        return { ok: false, reason: ra.name + " vs " + nb.name };
      }
      if (ra.args.length !== nb.args.length) {
        return {
          ok: false,
          reason: ra.name + " arity " + String(ra.args.length) + " vs " + String(nb.args.length),
        };
      }
      for (let i = 0; i < ra.args.length; i++) {
        const r = unify(ra.args[i] as MType, nb.args[i] as MType, subst, state);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case "array":
      return unify(ra.elem, (rb as { kind: "array"; elem: MType }).elem, subst, state);
    case "fn": {
      const fb = rb as Extract<MType, { kind: "fn" }>;
      if (ra.params.length !== fb.params.length) {
        return {
          ok: false,
          reason: "arity " + String(ra.params.length) + " vs " + String(fb.params.length),
        };
      }
      for (let i = 0; i < ra.params.length; i++) {
        const r = unify(ra.params[i] as MType, fb.params[i] as MType, subst, state);
        if (!r.ok) return r;
      }
      const retR = unify(ra.ret, fb.ret, subst, state);
      if (!retR.ok) return retR;
      return unify(fnEffects(ra), fnEffects(fb), subst, state);
    }
    case "record":
      return unify(ra.row, (rb as { kind: "record"; row: MType }).row, subst, state);
    case "row":
      return unifyRows(ra, rb as Extract<MType, { kind: "row" }>, subst, state);
    case "linear":
      return unify(ra.inner, (rb as { kind: "linear"; inner: MType }).inner, subst, state);
    case "affine":
      return unify(ra.inner, (rb as { kind: "affine"; inner: MType }).inner, subst, state);
    case "variant": {
      const vb = rb as { kind: "variant"; tag: string; fields: MType[] };
      if (ra.tag !== vb.tag || ra.fields.length !== vb.fields.length) {
        return { ok: false, reason: "variant " + ra.tag + " vs " + vb.tag };
      }
      for (let i = 0; i < ra.fields.length; i++) {
        const r = unify(ra.fields[i] as MType, vb.fields[i] as MType, subst, state);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case "scheme":
      return { ok: false, reason: "cannot unify with scheme" };
  }
}

/**
 * Unify two row types (Leijen-style). Align field labels:
 *  - field in both: unify field types
 *  - field only in a: extend b's tail (or error if b closed)
 *  - field only in b: extend a's tail (or error if a closed)
 *  - tails: closed/closed must both be empty; open/closed binds open tail to closed empty;
 *    open/open binds both tails to a fresh shared row var.
 */
function unifyRows(
  a: Extract<MType, { kind: "row" }>,
  b: Extract<MType, { kind: "row" }>,
  subst: Substitution,
  state: State,
): UnifyResult {
  const flatA = resolveRow(a, subst);
  const flatB = resolveRow(b, subst);
  if (flatA.kind !== "row") return unify(flatA, b, subst, state);
  if (flatB.kind !== "row") return unify(a, flatB, subst, state);

  const onlyA = new Map<string, MType>();
  const onlyB = new Map<string, MType>(flatB.fields);
  for (const [k, va] of flatA.fields) {
    const vb = onlyB.get(k);
    if (vb === undefined) {
      onlyA.set(k, va);
    } else {
      const r = unify(va, vb, subst, state);
      if (!r.ok) return { ok: false, reason: "field " + k + ": " + r.reason };
      onlyB.delete(k);
    }
  }

  const aClosed = flatA.rest === "empty";
  const bClosed = flatB.rest === "empty";

  if (onlyA.size > 0) {
    // a has fields b doesn't — extend b's tail
    if (bClosed) {
      return {
        ok: false,
        reason: "closed record missing field(s): " + [...onlyA.keys()].join(","),
      };
    }
  }
  if (onlyB.size > 0) {
    if (aClosed) {
      return {
        ok: false,
        reason: "closed record missing field(s): " + [...onlyB.keys()].join(","),
      };
    }
  }

  // Now build tails.
  // Case: both closed, no extras → done
  if (aClosed && bClosed) {
    if (onlyA.size === 0 && onlyB.size === 0) return { ok: true };
    return { ok: false, reason: "closed rows differ" };
  }

  // a open: bind a.rest to a row containing onlyB + new shared tail (or empty if b closed)
  // b open: bind b.rest to a row containing onlyA + new shared tail (or empty if a closed)
  const aRest = flatA.rest;
  const bRest = flatB.rest;

  if (!aClosed && !bClosed) {
    if (typeof aRest === "number" && typeof bRest === "number" && aRest === bRest) {
      // same tail var — must have no extras
      if (onlyA.size === 0 && onlyB.size === 0) return { ok: true };
      return { ok: false, reason: "row tail aliasing prevents extension" };
    }
    // Fresh shared tail.
    const sharedId = state.freshId();
    const sharedTail: MType = { kind: "var", id: sharedId };
    if (typeof aRest === "number") {
      if (occurs(aRest, sharedTail, subst)) return { ok: false, reason: "occurs in row" };
      const newARow: MType = { kind: "row", fields: onlyB, rest: sharedId };
      subst.set(aRest, newARow);
    }
    if (typeof bRest === "number") {
      if (occurs(bRest, sharedTail, subst)) return { ok: false, reason: "occurs in row" };
      const newBRow: MType = { kind: "row", fields: onlyA, rest: sharedId };
      subst.set(bRest, newBRow);
    }
    return { ok: true };
  }

  if (!aClosed && bClosed) {
    // bind a.rest to closed row of onlyB
    if (typeof aRest === "number") {
      const newARow: MType = { kind: "row", fields: onlyB, rest: "empty" };
      subst.set(aRest, newARow);
    }
    return { ok: true };
  }

  // aClosed && !bClosed
  if (typeof bRest === "number") {
    const newBRow: MType = { kind: "row", fields: onlyA, rest: "empty" };
    subst.set(bRest, newBRow);
  }
  return { ok: true };
}

function unifyOrError(ctx: Ctx, expected: MType, got: MType, message: string): boolean {
  const r = unify(expected, got, ctx.state.subst, ctx.state);
  if (r.ok) return true;
  const ze = zonk(expected, ctx.state.subst);
  const zg = zonk(got, ctx.state.subst);
  addError(ctx, "TYPE_MISMATCH", message + ": " + r.reason, {
    expected: typeName(ze),
    got: typeName(zg),
  });
  return false;
}

// ---------------------------------------------------------------------------
// Generalization + instantiation
// ---------------------------------------------------------------------------

function generalize(t: MType, env: TypeEnv, subst: Substitution): MType {
  const tVars = new Set<number>();
  ftv(t, subst, tVars);
  if (tVars.size === 0) return t;
  const envVars = ftvOfEnv(env, subst);
  const quantified: number[] = [];
  for (const id of tVars) if (!envVars.has(id)) quantified.push(id);
  if (quantified.length === 0) return t;
  return { kind: "scheme", quantified, body: zonk(t, subst) };
}

function instantiate(t: MType, state: State): MType {
  const r = t.kind === "scheme" ? t : null;
  if (r === null) return t;
  const mapping = new Map<number, MType>();
  for (const id of r.quantified) mapping.set(id, state.freshVar());
  return substVars(r.body, mapping);
}

function substVars(t: MType, mapping: Map<number, MType>): MType {
  switch (t.kind) {
    case "var": {
      const m = mapping.get(t.id);
      return m ?? t;
    }
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
      return t;
    case "named":
      return {
        kind: "named",
        name: t.name,
        args: t.args.map((a) => substVars(a, mapping)),
      };
    case "array":
      return { kind: "array", elem: substVars(t.elem, mapping) };
    case "row": {
      const fields = new Map<string, MType>();
      for (const [k, v] of t.fields) fields.set(k, substVars(v, mapping));
      let rest = t.rest;
      if (typeof rest === "number") {
        const m = mapping.get(rest);
        if (m !== undefined && m.kind === "var") rest = m.id;
      }
      return { kind: "row", fields, rest };
    }
    case "record":
      return { kind: "record", row: substVars(t.row, mapping) };
    case "fn": {
      const out: Extract<MType, { kind: "fn" }> = {
        kind: "fn",
        params: t.params.map((p) => substVars(p, mapping)),
        ret: substVars(t.ret, mapping),
      };
      if (t.effects !== undefined) out.effects = substVars(t.effects, mapping);
      return out;
    }
    case "linear":
      return { kind: "linear", inner: substVars(t.inner, mapping) };
    case "affine":
      return { kind: "affine", inner: substVars(t.inner, mapping) };
    case "variant":
      return {
        kind: "variant",
        tag: t.tag,
        fields: t.fields.map((f) => substVars(f, mapping)),
      };
    case "scheme": {
      const innerMap = new Map(mapping);
      for (const q of t.quantified) innerMap.delete(q);
      return {
        kind: "scheme",
        quantified: t.quantified,
        body: substVars(t.body, innerMap),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Type annotation parsing
// ---------------------------------------------------------------------------

function parseTypeAnnotation(s: string, params?: Set<string>): MType {
  // `linear T` / `affine T` — recognised as a prefix modifier so users can
  // opt into linearity on parameter / field annotations.
  if (s.startsWith("linear ")) {
    return { kind: "linear", inner: parseTypeAnnotation(s.slice(7), params) };
  }
  if (s.startsWith("affine ")) {
    return { kind: "affine", inner: parseTypeAnnotation(s.slice(7), params) };
  }
  switch (s) {
    case "null":
      return NULL_T;
    case "bool":
    case "boolean":
      return BOOL;
    case "int":
      return INT;
    case "float":
      return FLOAT;
    case "string":
      return STRING;
    case "bytes":
      return BYTES;
    case "unknown":
      return UNKNOWN;
    default:
      // If the annotation matches a known type parameter, return a placeholder
      // "named" sentinel that `instantiateWith` will replace with a fresh var.
      if (params !== undefined && params.has(s)) {
        return { kind: "named", name: s, args: [] };
      }
      return UNKNOWN;
  }
}

function isUpperCase(s: string): boolean {
  return s.length > 0 && (s[0] as string) >= "A" && (s[0] as string) <= "Z";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notYetImplemented(ctx: Ctx, op: string): MType {
  addError(ctx, "NOT_YET_IMPLEMENTED", "op not yet implemented: " + op);
  return ctx.state.freshVar();
}

function expectArity(ctx: Ctx, op: string, arr: Expr[], n: number): boolean {
  if (arr.length !== n + 1) {
    addError(
      ctx,
      "ARITY_ERROR",
      op + " requires " + String(n) + " args, got " + String(arr.length - 1),
    );
    return false;
  }
  return true;
}

function expectArityRange(ctx: Ctx, op: string, arr: Expr[], min: number, max: number): boolean {
  const got = arr.length - 1;
  if (got < min || got > max) {
    addError(
      ctx,
      "ARITY_ERROR",
      op + " requires " + String(min) + "-" + String(max) + " args, got " + String(got),
    );
    return false;
  }
  return true;
}

/** Build an open record type with one known field, used for `get`/`set` constraints. */
function openRecordWithField(state: State, key: string, fieldT: MType): MType {
  const tailId = state.freshId();
  const fields = new Map<string, MType>([[key, fieldT]]);
  return { kind: "record", row: { kind: "row", fields, rest: tailId } };
}

/** Build a record type out of explicit row pieces. */
function recordOf(fields: Map<string, MType>, rest: number | "empty"): MType {
  return { kind: "record", row: { kind: "row", fields, rest } };
}

/** Empty closed row — used as the default "pure" effect row. */
function emptyEffects(): MType {
  return { kind: "row", fields: new Map(), rest: "empty" };
}

/** Open empty row — used as a fresh effect row var to be filled in. */
function freshEffectsRow(state: State): MType {
  return { kind: "row", fields: new Map(), rest: state.freshId() };
}

/**
 * Get the effects row of a fn type, defaulting to the empty closed row when
 * absent. Function literals constructed without an `effects` field are treated
 * as pure.
 */
function fnEffects(fn: Extract<MType, { kind: "fn" }>): MType {
  return fn.effects ?? emptyEffects();
}

/**
 * Add a single effect tag to a row, returning the extended row. The original
 * row's tail var is bound (via substitution) to a new row that contains the
 * tag plus a fresh tail. This is the same trick used to extend record rows.
 */
function addEffectToRow(row: MType, tag: string, payload: MType, state: State): UnifyResult {
  const target: MType = {
    kind: "row",
    fields: new Map([[tag, payload]]),
    rest: state.freshId(),
  };
  return unify(row, target, state.subst, state);
}

/**
 * Absorb a (callee's) effect row into the current ambient effect row. This
 * gives subset semantics — any tags concrete in `source` are added to
 * `ctx.currentEffects`, and if the source has an open tail, that tail is
 * unified with current's tail so further extensions to either propagate.
 *
 * If the source is closed-empty, this is a no-op (pure functions add no
 * effects).
 */
function absorbEffects(source: MType, ctx: Ctx): void {
  const flat = resolveRow(source, ctx.state.subst);
  if (flat.kind !== "row") {
    // Source isn't a row — leave the substitution to handle it. Treat as no-op.
    return;
  }
  for (const [tag, payload] of flat.fields) {
    const r = addEffectToRow(ctx.currentEffects, tag, payload, ctx.state);
    if (!r.ok) {
      addError(ctx, "TYPE_MISMATCH", "effect row mismatch for " + tag + ": " + r.reason);
    }
  }
  // If source has an open tail, bind it to a row that mirrors the current
  // effect row's *fields* with current's tail. This makes the source row
  // structurally equal to current (so subsequent unifications can't fail
  // due to the source row missing fields that current has gained).
  if (typeof flat.rest === "number") {
    const tailVar: MType = { kind: "var", id: flat.rest };
    const curFlat = resolveRow(ctx.currentEffects, ctx.state.subst);
    if (curFlat.kind === "row") {
      // Only mirror fields that aren't already in source — otherwise we'd
      // duplicate. The source already absorbed its own fields above; the
      // tail should carry the *rest* (current's exclusive fields) plus
      // current's tail.
      const mirror = new Map<string, MType>();
      for (const [k, v] of curFlat.fields) {
        if (!flat.fields.has(k)) mirror.set(k, v);
      }
      const tailRest: number | "empty" = typeof curFlat.rest === "number" ? curFlat.rest : "empty";
      const tr = find(tailVar, ctx.state.subst);
      if (tr.kind === "var") {
        // Avoid binding to ourselves (would create a cycle).
        if (typeof tailRest !== "number" || tr.id !== tailRest) {
          const mirrorRow: MType = {
            kind: "row",
            fields: mirror,
            rest: tailRest,
          };
          ctx.state.subst.set(tr.id, mirrorRow);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inference (Algorithm W)
// ---------------------------------------------------------------------------

function infer(expr: Expr, env: TypeEnv, ctx: Ctx): MType {
  const result = _infer(expr, env, ctx);
  if (ctx.typeIndex !== undefined) {
    const key = JSON.stringify(ctx.path);
    if (!ctx.typeIndex.has(key)) {
      ctx.typeIndex.set(key, { type: result, effectsRowId: ctx.currentEffects });
    }
  }
  return result;
}

function _infer(expr: Expr, env: TypeEnv, ctx: Ctx): MType {
  if (expr === null) return NULL_T;
  if (typeof expr === "boolean") return BOOL;
  if (typeof expr === "number") return Number.isInteger(expr) ? INT : FLOAT;
  if (typeof expr === "string") {
    const t = env.lookup(expr);
    if (t === undefined) {
      addError(ctx, "UNDEFINED_VAR", "undefined variable: " + expr);
      return ctx.state.freshVar();
    }
    return instantiate(t, ctx.state);
  }

  const arr = expr as Expr[];
  if (arr.length === 0) {
    addError(ctx, "UNKNOWN_OP", "empty expression array");
    return ctx.state.freshVar();
  }

  const opExpr = arr[0];
  if (typeof opExpr !== "string") {
    addError(ctx, "UNKNOWN_OP", "first element of call must be an op name (string)");
    return ctx.state.freshVar();
  }
  const op = opExpr;

  if (isUpperCase(op)) {
    return inferVariantConstructor(op, arr, env, ctx);
  }

  return inferOp(op, arr, env, ctx);
}

/**
 * Look up a variant constructor and produce a `named<...>` type with fresh
 * type-parameter vars. Each field of the constructor is unified against the
 * inferred argument type.
 */
function inferVariantConstructor(tag: string, arr: Expr[], env: TypeEnv, ctx: Ctx): MType {
  const typeName_ = ctx.ctors.get(tag);
  if (typeName_ === undefined) {
    // Still typecheck arguments so inner errors surface, then error.
    for (let i = 1; i < arr.length; i++) {
      withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
    }
    addError(ctx, "UNKNOWN_VARIANT", "unknown variant constructor: " + tag);
    return ctx.state.freshVar();
  }
  const def = ctx.typeDefs.get(typeName_) as TypeDefInfo;
  // Allocate fresh vars for each type parameter.
  const paramVars = new Map<string, MType>();
  const paramArgs: MType[] = [];
  for (const p of def.params) {
    const v = ctx.state.freshVar();
    paramVars.set(p, v);
    paramArgs.push(v);
  }
  const fieldTypes = (def.variants.get(tag) as MType[]).map((ft) => instantiateWith(ft, paramVars));
  const argCount = arr.length - 1;
  if (argCount !== fieldTypes.length) {
    for (let i = 1; i < arr.length; i++) {
      withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
    }
    addError(
      ctx,
      "ARITY_ERROR",
      tag + " expects " + String(fieldTypes.length) + " field(s), got " + String(argCount),
    );
    return { kind: "named", name: typeName_, args: paramArgs };
  }
  for (let i = 1; i < arr.length; i++) {
    const argT = withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
    const expected = fieldTypes[i - 1] as MType;
    withPath(ctx, i, (sub) => unifyOrError(sub, expected, argT, tag + ": field " + String(i - 1)));
  }
  return { kind: "named", name: typeName_, args: paramArgs };
}

/**
 * Replace type-parameter placeholders (special "var" types stored in a map by
 * name) inside a stored field-type. Field types in TypeDefInfo use special
 * placeholder vars: {kind:"var", id: -K} where K is the index in def.params.
 * We accept the placeholder convention: we use a Map<string, MType> for fresh
 * args and identify placeholders by a separate marker. To keep things simple
 * we instead store field types using {kind:"var", id} where ids are "param
 * tokens" tracked separately. For Phase 3 we use a simpler approach: field
 * types are stored with literal `{kind:"named", name:"<paramName>", args:[]}`
 * acting as a sentinel — and `instantiateWith` rewrites those.
 */
function instantiateWith(t: MType, paramVars: Map<string, MType>): MType {
  switch (t.kind) {
    case "named": {
      const replacement = paramVars.get(t.name);
      if (replacement !== undefined && t.args.length === 0) return replacement;
      return {
        kind: "named",
        name: t.name,
        args: t.args.map((a) => instantiateWith(a, paramVars)),
      };
    }
    case "var":
    case "unknown":
    case "null":
    case "bool":
    case "int":
    case "float":
    case "string":
    case "bytes":
      return t;
    case "array":
      return { kind: "array", elem: instantiateWith(t.elem, paramVars) };
    case "row": {
      const fields = new Map<string, MType>();
      for (const [k, v] of t.fields) fields.set(k, instantiateWith(v, paramVars));
      return { kind: "row", fields, rest: t.rest };
    }
    case "record":
      return { kind: "record", row: instantiateWith(t.row, paramVars) };
    case "fn": {
      const out: Extract<MType, { kind: "fn" }> = {
        kind: "fn",
        params: t.params.map((p) => instantiateWith(p, paramVars)),
        ret: instantiateWith(t.ret, paramVars),
      };
      if (t.effects !== undefined) out.effects = instantiateWith(t.effects, paramVars);
      return out;
    }
    case "linear":
      return { kind: "linear", inner: instantiateWith(t.inner, paramVars) };
    case "affine":
      return { kind: "affine", inner: instantiateWith(t.inner, paramVars) };
    case "variant":
      return {
        kind: "variant",
        tag: t.tag,
        fields: t.fields.map((f) => instantiateWith(f, paramVars)),
      };
    case "scheme":
      return {
        kind: "scheme",
        quantified: t.quantified,
        body: instantiateWith(t.body, paramVars),
      };
  }
}

/**
 * Infer the type of a `match` expression.
 *
 * Form: ["match", scrut, [pattern1, body1], [pattern2, body2], ...]
 *
 * Patterns:
 *   - ["Tag", binding1, ...] — variant pattern; bindings receive field types
 *   - "_"                    — wildcard
 *   - lowercase name         — variable binding (binds scrutinee)
 *   - literal int/string/bool — literal pattern (matches when equal)
 *
 * Exhaustiveness: if scrutinee resolves to a `named<...>` type, all variants of
 * that type must be covered (or a wildcard / variable pattern present).
 */
function inferMatch(arr: Expr[], env: TypeEnv, ctx: Ctx): MType {
  const state = ctx.state;
  if (arr.length < 3) {
    addError(ctx, "ARITY_ERROR", "match requires a scrutinee and at least 1 clause");
    return state.freshVar();
  }
  const scrutT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
  const result = state.freshVar();

  /** Tags covered by an exact tag pattern. */
  const coveredTags = new Set<string>();
  /** Whether some clause covers everything (wildcard / var pattern). */
  let sawCatchAll = false;

  for (let i = 2; i < arr.length; i++) {
    const clause = arr[i];
    if (!Array.isArray(clause) || clause.length !== 2) {
      withPath(ctx, i, (sub) =>
        addError(sub, "TYPE_MISMATCH", "match clause must be [pattern, body]"),
      );
      continue;
    }
    const pattern = clause[0];
    const body = clause[1] as Expr;

    let clauseEnv = env;

    if (pattern === "_") {
      sawCatchAll = true;
    } else if (typeof pattern === "string") {
      // Variable binding (any lowercase string acts as a fresh binding to scrutinee type)
      // or a string literal pattern (matches when scrutinee is a string).
      // Spec doesn't have a separate var-binding form; we treat lowercase identifiers as bindings.
      if (pattern.length > 0 && !isUpperCase(pattern)) {
        clauseEnv = env.extend({ [pattern]: scrutT });
        sawCatchAll = true;
      } else {
        // Treat as string literal — unify scrutinee with string.
        withPath(ctx, i, (sub) =>
          withPath(sub, 0, (sub2) =>
            unifyOrError(sub2, STRING, scrutT, "match: string literal pattern"),
          ),
        );
      }
    } else if (typeof pattern === "number") {
      const litT = Number.isInteger(pattern) ? INT : FLOAT;
      withPath(ctx, i, (sub) =>
        withPath(sub, 0, (sub2) => unifyOrError(sub2, litT, scrutT, "match: numeric literal")),
      );
    } else if (typeof pattern === "boolean") {
      withPath(ctx, i, (sub) =>
        withPath(sub, 0, (sub2) => unifyOrError(sub2, BOOL, scrutT, "match: bool literal")),
      );
    } else if (Array.isArray(pattern) && pattern.length >= 1 && typeof pattern[0] === "string") {
      const tag = pattern[0];
      const bindings = pattern.slice(1);
      const typeName_ = ctx.ctors.get(tag);
      if (typeName_ === undefined) {
        withPath(ctx, i, (sub) =>
          withPath(sub, 0, (sub2) =>
            addError(sub2, "UNKNOWN_VARIANT", "unknown variant constructor in pattern: " + tag),
          ),
        );
        continue;
      }
      const def = ctx.typeDefs.get(typeName_) as TypeDefInfo;
      const paramVars = new Map<string, MType>();
      const paramArgs: MType[] = [];
      for (const p of def.params) {
        const v = state.freshVar();
        paramVars.set(p, v);
        paramArgs.push(v);
      }
      const fieldTypes = (def.variants.get(tag) as MType[]).map((ft) =>
        instantiateWith(ft, paramVars),
      );
      // Unify scrutinee with named<...> for this DU.
      const expectedScrut: MType = {
        kind: "named",
        name: typeName_,
        args: paramArgs,
      };
      withPath(ctx, i, (sub) =>
        withPath(sub, 0, (sub2) =>
          unifyOrError(sub2, expectedScrut, scrutT, "match: scrutinee type"),
        ),
      );
      // Check binding count. Wildcards "_" allowed.
      if (bindings.length !== fieldTypes.length) {
        withPath(ctx, i, (sub) =>
          withPath(sub, 0, (sub2) =>
            addError(
              sub2,
              "ARITY_ERROR",
              tag +
                " pattern: expected " +
                String(fieldTypes.length) +
                " bindings, got " +
                String(bindings.length),
            ),
          ),
        );
      }
      const newBindings: Record<string, MType> = {};
      const n = Math.min(bindings.length, fieldTypes.length);
      for (let j = 0; j < n; j++) {
        const b = bindings[j];
        if (typeof b !== "string") {
          withPath(ctx, i, (sub) =>
            withPath(sub, 0, (sub2) =>
              addError(sub2, "TYPE_MISMATCH", "match binding name must be a string"),
            ),
          );
          continue;
        }
        if (b !== "_") newBindings[b] = fieldTypes[j] as MType;
      }
      clauseEnv = env.extend(newBindings);
      coveredTags.add(tag);
    } else {
      withPath(ctx, i, (sub) =>
        withPath(sub, 0, (sub2) => addError(sub2, "TYPE_MISMATCH", "match: invalid pattern")),
      );
      continue;
    }

    const bodyT = withPath(ctx, i, (sub) =>
      withPath(sub, 1, (sub2) => infer(body, clauseEnv, sub2)),
    );
    withPath(ctx, i, (sub) =>
      withPath(sub, 1, (sub2) => unifyOrError(sub2, result, bodyT, "match: branch result type")),
    );
  }

  // Exhaustiveness check.
  if (!sawCatchAll) {
    const resolved = find(scrutT, ctx.state.subst);
    if (resolved.kind === "named") {
      const def = ctx.typeDefs.get(resolved.name);
      if (def !== undefined) {
        const missing: string[] = [];
        for (const tag of def.variants.keys()) {
          if (!coveredTags.has(tag)) missing.push(tag);
        }
        if (missing.length > 0) {
          addError(
            ctx,
            "NON_EXHAUSTIVE_MATCH",
            "non-exhaustive match on " +
              resolved.name +
              ": missing variant(s) " +
              missing.join(", "),
          );
        }
      }
    }
  }

  return result;
}

/**
 * Look up the effect signature for `tag`, allocating a fresh one (with fresh
 * payload/resume vars) on the first reference. This matches the spec's
 * "user-defined effects" model — unknown tags become typed on demand rather
 * than erroring.
 */
function lookupOrAllocEffectSig(tag: string, ctx: Ctx): EffectSig {
  let sig = ctx.effectSigs.get(tag);
  if (sig === undefined) {
    sig = { payload: ctx.state.freshVar(), resume: ctx.state.freshVar() };
    ctx.effectSigs.set(tag, sig);
  }
  return sig;
}

/**
 * Infer the type of `["perform", "Tag", payload]`.
 *
 * Adds the tag to the ambient effect row (`ctx.currentEffects`), unifies
 * the payload expression's type against the tag's registered payload type,
 * and returns the tag's resume type (the value the continuation receives).
 */
function inferPerform(arr: Expr[], env: TypeEnv, ctx: Ctx): MType {
  if (!expectArity(ctx, "perform", arr, 2)) return ctx.state.freshVar();
  const tagExpr = arr[1];
  if (typeof tagExpr !== "string") {
    withPath(ctx, 1, (sub) =>
      addError(sub, "TYPE_MISMATCH", "perform: effect tag must be a string"),
    );
    return ctx.state.freshVar();
  }
  const sig = lookupOrAllocEffectSig(tagExpr, ctx);
  const payloadT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
  withPath(ctx, 2, (sub) =>
    unifyOrError(sub, sig.payload, payloadT, "perform: payload type for " + tagExpr),
  );
  const r = addEffectToRow(ctx.currentEffects, tagExpr, sig.payload, ctx.state);
  if (!r.ok) {
    addError(ctx, "TYPE_MISMATCH", "perform: cannot extend effect row with " + tagExpr);
  }
  return sig.resume;
}

/**
 * Infer the type of `["handle", body, clause1, ...]`.
 *
 * Each clause is `[pattern, clauseBody]`. Patterns are either an effect-tag
 * pattern `["Tag", payloadBinding, kBinding]` or a return pattern
 * `["return", xBinding]`.
 *
 * Strategy:
 *  - Allocate an inner effect row (the body is inferred against this).
 *  - Allocate a result type for the whole `handle` expression.
 *  - For each effect clause, register the tag as "handled": its bindings see
 *    `payloadBinding: P` and `kBinding: fn(R) -> resultType` where R is the
 *    resume type. The clause body must unify to `resultType`. The handled
 *    tag is recorded so we can subtract it from the inner row.
 *  - The return clause binds `x: bodyT` and its body must unify to
 *    `resultType`. Without a return clause, `resultType` defaults to the
 *    body's type.
 *  - Finally, unify the inner effect row with `{handled tags... | outerEffects}`,
 *    so the outer row is extended with any unhandled tags from the body.
 */
function inferHandle(arr: Expr[], env: TypeEnv, ctx: Ctx): MType {
  const state = ctx.state;
  if (arr.length < 2) {
    addError(ctx, "ARITY_ERROR", "handle requires at least a body");
    return state.freshVar();
  }

  // Save outer effects, install fresh inner effects row that the body
  // accumulates into.
  const outerEffects = ctx.currentEffects;
  const innerEffects = freshEffectsRow(state);

  ctx.currentEffects = innerEffects;
  const bodyT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
  ctx.currentEffects = outerEffects;

  // The overall result type. Either inferred from a return clause or, when no
  // return clause is present, defaults to the body type.
  const resultT = state.freshVar();
  let sawReturnClause = false;

  // Tags handled by clauses, with their payload types. These are subtracted
  // from the inner row when computing what propagates to the outer row.
  const handledTags = new Map<string, MType>();

  for (let i = 2; i < arr.length; i++) {
    const clause = arr[i];
    if (!Array.isArray(clause) || clause.length !== 2) {
      withPath(ctx, i, (sub) =>
        addError(sub, "TYPE_MISMATCH", "handle clause must be [pattern, body]"),
      );
      continue;
    }
    const pattern = clause[0];
    const clauseBody = clause[1] as Expr;
    if (!Array.isArray(pattern) || pattern.length < 1 || typeof pattern[0] !== "string") {
      withPath(ctx, i, (sub) =>
        withPath(sub, 0, (sub2) =>
          addError(sub2, "TYPE_MISMATCH", "handle clause pattern must be [tag, ...bindings]"),
        ),
      );
      continue;
    }
    const tag = pattern[0];

    if (tag === "return") {
      if (pattern.length !== 2 || typeof pattern[1] !== "string") {
        withPath(ctx, i, (sub) =>
          withPath(sub, 0, (sub2) =>
            addError(sub2, "TYPE_MISMATCH", 'handle return clause must be ["return", binding]'),
          ),
        );
        continue;
      }
      sawReturnClause = true;
      const xBinding = pattern[1];
      const clauseEnv = env.extend({ [xBinding]: bodyT });
      const cT = withPath(ctx, i, (sub) =>
        withPath(sub, 1, (sub2) => infer(clauseBody, clauseEnv, sub2)),
      );
      withPath(ctx, i, (sub) =>
        withPath(sub, 1, (sub2) =>
          unifyOrError(sub2, resultT, cT, "handle: return clause body type"),
        ),
      );
      continue;
    }

    // Effect clause: [Tag, payloadBinding, kBinding]
    if (pattern.length !== 3 || typeof pattern[1] !== "string" || typeof pattern[2] !== "string") {
      withPath(ctx, i, (sub) =>
        withPath(sub, 0, (sub2) =>
          addError(
            sub2,
            "TYPE_MISMATCH",
            "handle effect clause must be [Tag, payloadBinding, kBinding]",
          ),
        ),
      );
      continue;
    }
    const payloadBinding = pattern[1];
    const kBinding = pattern[2];
    const sig = lookupOrAllocEffectSig(tag, ctx);
    handledTags.set(tag, sig.payload);
    // k receives a value of type `resume` and produces the handle's result.
    // Its effect row is the outer effect row — calling k re-enters the
    // handled context, but any further effects propagate to the outer scope.
    const kType: MType = {
      kind: "fn",
      params: [sig.resume],
      ret: resultT,
      effects: outerEffects,
    };
    const clauseEnv = env.extend({
      [payloadBinding]: sig.payload,
      [kBinding]: kType,
    });
    const cT = withPath(ctx, i, (sub) =>
      withPath(sub, 1, (sub2) => infer(clauseBody, clauseEnv, sub2)),
    );
    withPath(ctx, i, (sub) =>
      withPath(sub, 1, (sub2) =>
        unifyOrError(sub2, resultT, cT, "handle: " + tag + " clause body type"),
      ),
    );
  }

  // If there's no return clause, the body's type IS the result type.
  if (!sawReturnClause) {
    unifyOrError(ctx, resultT, bodyT, "handle: body type (no return clause)");
  }

  // Unify the inner effect row with `{handledTags... | outerEffects}` — the
  // body's effects are the handled set plus whatever propagates outward.
  // We accomplish this by building a row of handled fields with a tail that
  // is the outer row (resolved to its tail var if possible).
  const outerFlat = resolveRow(outerEffects, state.subst);
  let tailRest: number | "empty";
  if (outerFlat.kind === "row" && typeof outerFlat.rest === "number") {
    tailRest = outerFlat.rest;
  } else if (outerFlat.kind === "row" && outerFlat.rest === "empty") {
    tailRest = "empty";
  } else {
    tailRest = state.freshId();
  }
  // Add any concrete fields the outer row already has so they're visible in
  // the inner row's view (they could also be absorbed via the tail var, but
  // mirroring them keeps the rows symmetric).
  const innerExpected: Map<string, MType> = new Map();
  if (outerFlat.kind === "row") {
    for (const [k, v] of outerFlat.fields) innerExpected.set(k, v);
  }
  for (const [tag, payload] of handledTags) {
    if (!innerExpected.has(tag)) innerExpected.set(tag, payload);
  }
  const innerExpectedRow: MType = {
    kind: "row",
    fields: innerExpected,
    rest: tailRest,
  };
  const u = unify(innerEffects, innerExpectedRow, state.subst, state);
  if (!u.ok) {
    addError(ctx, "TYPE_MISMATCH", "handle: effect row mismatch: " + u.reason);
  }

  return resultT;
}

/**
 * Infer the type of `["call.method", cap, "methodName", ...args]`.
 *
 * Resolves the cap's type. If it's `Cap<T>` where `T` is a known cap-interface
 * name (e.g. `Network`, `Storage`), look up the method, unify args against the
 * registered param types, add the method's effect to the ambient effect row,
 * and return the method's return type. If `T` is `unknown` or a plugin-defined
 * cap not in the table, fall back to `unknown` (gradual escape). If the cap
 * isn't a `Cap<_>` type at all, raise TYPE_MISMATCH.
 *
 * Capabilities are `linear` by default per spec — Phase 6 will enforce that.
 */
function inferCallMethod(arr: Expr[], env: TypeEnv, ctx: Ctx): MType {
  const state = ctx.state;
  if (arr.length < 3) {
    addError(ctx, "ARITY_ERROR", "call.method requires a cap and a method name");
    // Still infer subexpressions so inner errors surface.
    for (let i = 1; i < arr.length; i++) {
      withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
    }
    return state.freshVar();
  }
  const capT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
  const methodExpr = arr[2];
  if (typeof methodExpr !== "string") {
    withPath(ctx, 2, (sub) =>
      addError(sub, "TYPE_MISMATCH", "call.method: method name must be a string literal"),
    );
    for (let i = 3; i < arr.length; i++) {
      withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
    }
    return state.freshVar();
  }
  const argTypes: MType[] = [];
  for (let i = 3; i < arr.length; i++) {
    argTypes.push(withPath(ctx, i, (sub) => infer(at(arr, i), env, sub)));
  }

  const resolved = find(capT, state.subst);

  // Gradual escape: unknown cap → unknown result.
  if (resolved.kind === "unknown") return UNKNOWN;

  // Must be a Cap<_> named type. If it's a free var, leave it polymorphic
  // by returning unknown — without further info we can't pick a method.
  if (resolved.kind === "var") {
    // Constrain shape: must be a Cap<_> when ever resolved. We don't bind
    // it to anything concrete here — but we can't pick a method without
    // knowing the interface. Treat as unknown gradual escape.
    return UNKNOWN;
  }

  if (resolved.kind !== "named" || resolved.name !== "Cap" || resolved.args.length !== 1) {
    withPath(ctx, 1, (sub) =>
      addError(sub, "TYPE_MISMATCH", "call.method: expected Cap<_>, got " + typeName(resolved), {
        expected: "Cap<_>",
        got: typeName(resolved),
      }),
    );
    return state.freshVar();
  }

  const inner = find(resolved.args[0] as MType, state.subst);

  // Plugin-defined or unknown cap interface → gradual escape.
  if (inner.kind === "unknown" || inner.kind === "var") return UNKNOWN;

  if (inner.kind !== "named") {
    withPath(ctx, 1, (sub) =>
      addError(
        sub,
        "TYPE_MISMATCH",
        "call.method: Cap argument must be a named cap interface, got " + typeName(inner),
      ),
    );
    return state.freshVar();
  }

  const methods = ctx.capMethods.get(inner.name);
  if (methods === undefined) {
    // Unknown cap interface: plugin-defined, not registered. Gradual escape.
    return UNKNOWN;
  }
  const sig = methods.get(methodExpr);
  if (sig === undefined) {
    withPath(ctx, 2, (sub) =>
      addError(
        sub,
        "TYPE_MISMATCH",
        "call.method: " + inner.name + " has no method '" + methodExpr + "'",
        { expected: [...methods.keys()].join(" | "), got: methodExpr },
      ),
    );
    return state.freshVar();
  }

  if (argTypes.length !== sig.params.length) {
    addError(
      ctx,
      "ARITY_ERROR",
      "call.method: " +
        inner.name +
        "." +
        methodExpr +
        " expects " +
        String(sig.params.length) +
        " args, got " +
        String(argTypes.length),
    );
    return sig.ret;
  }

  for (let i = 0; i < argTypes.length; i++) {
    withPath(ctx, i + 3, (sub) =>
      unifyOrError(
        sub,
        sig.params[i] as MType,
        argTypes[i] as MType,
        "call.method: " + inner.name + "." + methodExpr + " arg " + String(i),
      ),
    );
  }

  // Add the method's effect tag to the ambient effect row.
  const sigForEffect = lookupOrAllocEffectSig(sig.effect, ctx);
  const r = addEffectToRow(ctx.currentEffects, sig.effect, sigForEffect.payload, ctx.state);
  if (!r.ok) {
    addError(
      ctx,
      "TYPE_MISMATCH",
      "call.method: cannot extend effect row with " + sig.effect + ": " + r.reason,
    );
  }

  return sig.ret;
}

function inferOp(op: string, arr: Expr[], env: TypeEnv, ctx: Ctx): MType {
  const state = ctx.state;
  const subst = state.subst;

  switch (op) {
    case "bytes": {
      return BYTES;
    }

    // -------------------- control flow --------------------
    case "if": {
      if (!expectArity(ctx, "if", arr, 3)) return state.freshVar();
      const condT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, BOOL, condT, "if condition must be bool"));
      const thenT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elseT = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      const result = state.freshVar();
      withPath(ctx, 2, (sub) => unifyOrError(sub, result, thenT, "if then-branch"));
      withPath(ctx, 3, (sub) => unifyOrError(sub, result, elseT, "if else-branch"));
      return result;
    }

    case "cond": {
      if (arr.length < 2) {
        addError(ctx, "ARITY_ERROR", "cond requires at least 1 clause");
        return state.freshVar();
      }
      const result = state.freshVar();
      let sawAny = false;
      for (let i = 1; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          withPath(ctx, i, (sub) =>
            addError(sub, "TYPE_MISMATCH", "cond clause must be [test, expr]"),
          );
          continue;
        }
        const test = clause[0];
        const body = clause[1] as Expr;
        if (test !== "else") {
          const testT = withPath(ctx, i, (sub) =>
            withPath(sub, 0, (sub2) => infer(test as Expr, env, sub2)),
          );
          withPath(ctx, i, (sub) =>
            withPath(sub, 0, (sub2) => unifyOrError(sub2, BOOL, testT, "cond test must be bool")),
          );
        }
        const branchT = withPath(ctx, i, (sub) =>
          withPath(sub, 1, (sub2) => infer(body, env, sub2)),
        );
        withPath(ctx, i, (sub) =>
          withPath(sub, 1, (sub2) => unifyOrError(sub2, result, branchT, "cond branch")),
        );
        sawAny = true;
      }
      if (!sawAny) return state.freshVar();
      return result;
    }

    case "do": {
      if (arr.length < 2) {
        addError(ctx, "ARITY_ERROR", "do requires at least 1 expr");
        return state.freshVar();
      }
      let last: MType = state.freshVar();
      for (let i = 1; i < arr.length; i++) {
        last = withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
      }
      return last;
    }

    // -------------------- let / letrec --------------------
    case "let": {
      if (!expectArity(ctx, "let", arr, 2)) return state.freshVar();
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        withPath(ctx, 1, (sub) => addError(sub, "TYPE_MISMATCH", "let bindings must be an array"));
        return state.freshVar();
      }
      let currentEnv = env;
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) {
          withPath(ctx, 1, (sub) =>
            withPath(sub, i, (sub2) =>
              addError(sub2, "TYPE_MISMATCH", "each let binding must be [name, expr]"),
            ),
          );
          continue;
        }
        const name = binding[0];
        if (typeof name !== "string") {
          withPath(ctx, 1, (sub) =>
            withPath(sub, i, (sub2) =>
              addError(sub2, "TYPE_MISMATCH", "let binding name must be a string"),
            ),
          );
          continue;
        }
        const valT = withPath(ctx, 1, (sub) =>
          withPath(sub, i, (sub2) => infer(binding[1] as Expr, currentEnv, sub2)),
        );
        const generalized = generalize(valT, currentEnv, subst);
        currentEnv = currentEnv.extend({ [name]: generalized });
      }
      return withPath(ctx, 2, (sub) => infer(at(arr, 2), currentEnv, sub));
    }

    case "letrec": {
      if (!expectArity(ctx, "letrec", arr, 2)) return state.freshVar();
      const bindings = arr[1];
      if (!Array.isArray(bindings)) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "letrec bindings must be an array"),
        );
        return state.freshVar();
      }
      const placeholders: Record<string, MType> = {};
      const names: string[] = [];
      const vars: MType[] = [];
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) continue;
        const name = binding[0];
        if (typeof name !== "string") continue;
        const v = state.freshVar();
        placeholders[name] = v;
        names.push(name);
        vars.push(v);
      }
      const recEnv = env.extend(placeholders);
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (!Array.isArray(binding) || binding.length !== 2) continue;
        const name = binding[0];
        if (typeof name !== "string") continue;
        const idx = names.indexOf(name);
        const bodyT = withPath(ctx, 1, (sub) =>
          withPath(sub, i, (sub2) => infer(binding[1] as Expr, recEnv, sub2)),
        );
        withPath(ctx, 1, (sub) =>
          withPath(sub, i, (sub2) =>
            unifyOrError(sub2, vars[idx] as MType, bodyT, "letrec binding " + name),
          ),
        );
      }
      const finalEnv = env.extend(
        Object.fromEntries(
          names.map((n, i) => [n, generalize(vars[i] as MType, env, subst)] as const),
        ),
      );
      return withPath(ctx, 2, (sub) => infer(at(arr, 2), finalEnv, sub));
    }

    // -------------------- functions --------------------
    // fn-once is a linearity-only annotation; it typechecks identically to fn.
    case "fn-once":
    case "fn": {
      if (!expectArity(ctx, op, arr, 2)) {
        return {
          kind: "fn",
          params: [],
          ret: state.freshVar(),
          effects: emptyEffects(),
        };
      }
      const paramsExpr = arr[1];
      if (!Array.isArray(paramsExpr)) {
        withPath(ctx, 1, (sub) => addError(sub, "TYPE_MISMATCH", "fn params must be an array"));
        return {
          kind: "fn",
          params: [],
          ret: state.freshVar(),
          effects: emptyEffects(),
        };
      }
      const paramTypes: MType[] = [];
      const paramBindings: Record<string, MType> = {};
      for (let i = 0; i < paramsExpr.length; i++) {
        const p = paramsExpr[i];
        if (typeof p === "string") {
          const v = state.freshVar();
          paramTypes.push(v);
          paramBindings[p] = v;
        } else if (Array.isArray(p) && p.length >= 2 && typeof p[0] === "string") {
          const annotated = parseTypeAnnotation(p[1] as string);
          paramTypes.push(annotated);
          paramBindings[p[0] as string] = annotated;
        } else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") {
          const v = state.freshVar();
          paramTypes.push(v);
          paramBindings[p[0] as string] = v;
        } else {
          withPath(ctx, 1, (sub) =>
            withPath(sub, i, (sub2) =>
              addError(sub2, "TYPE_MISMATCH", "fn param must be a string or [name, type] pair"),
            ),
          );
          paramTypes.push(state.freshVar());
        }
      }
      const fnEnv = env.extend(paramBindings);
      // Save outer effects, install a fresh row that the body accumulates into.
      const outerEffects = ctx.currentEffects;
      const bodyEffects = freshEffectsRow(state);
      ctx.currentEffects = bodyEffects;
      const retT = withPath(ctx, 2, (sub) => infer(at(arr, 2), fnEnv, sub));
      ctx.currentEffects = outerEffects;
      return {
        kind: "fn",
        params: paramTypes,
        ret: retT,
        effects: bodyEffects,
      };
    }

    case "call": {
      if (arr.length < 2) {
        addError(ctx, "ARITY_ERROR", "call requires at least 1 arg");
        return state.freshVar();
      }
      const fnT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const argTypes: MType[] = [];
      for (let i = 2; i < arr.length; i++) {
        argTypes.push(withPath(ctx, i, (sub) => infer(at(arr, i), env, sub)));
      }
      const ret = state.freshVar();
      // Allocate a fresh effect row for the callee — we'll absorb its
      // contents into currentEffects after unification (subset semantics).
      const calleeEffects: MType = freshEffectsRow(state);
      const expected: MType = {
        kind: "fn",
        params: argTypes,
        ret,
        effects: calleeEffects,
      };
      const resolved = find(fnT, subst);
      if (resolved.kind === "fn" && resolved.params.length !== argTypes.length) {
        addError(
          ctx,
          "ARITY_ERROR",
          "fn expects " + String(resolved.params.length) + " args, got " + String(argTypes.length),
        );
        return resolved.ret;
      }
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, expected, fnT, "call: function/argument mismatch"),
      );
      // Absorb the callee's concrete effect tags into the caller's row.
      absorbEffects(calleeEffects, ctx);
      return ret;
    }

    // -------------------- logic --------------------
    case "and":
    case "or": {
      if (!expectArity(ctx, op, arr, 2)) return BOOL;
      const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, BOOL, ta, op + " requires bool"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, BOOL, tb, op + " requires bool"));
      return BOOL;
    }

    case "not": {
      if (!expectArity(ctx, "not", arr, 1)) return BOOL;
      const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, BOOL, ta, "not requires bool"));
      return BOOL;
    }

    // -------------------- comparison --------------------
    case "==":
    case "!=": {
      if (!expectArity(ctx, op, arr, 2)) return BOOL;
      const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 2, (sub) => unifyOrError(sub, ta, tb, op + " requires same-typed operands"));
      return BOOL;
    }

    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (!expectArity(ctx, op, arr, 2)) return BOOL;
      const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 2, (sub) => unifyOrError(sub, ta, tb, op + " requires matching numeric types"));
      const rta = find(ta, subst);
      if (
        rta.kind !== "int" &&
        rta.kind !== "float" &&
        rta.kind !== "var" &&
        rta.kind !== "unknown"
      ) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires number, got " + typeName(rta), {
            expected: "int | float",
            got: typeName(rta),
          }),
        );
      }
      return BOOL;
    }

    // -------------------- arithmetic --------------------
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
    case "**": {
      if (op === "-" && arr.length === 2) {
        const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
        const rta = find(ta, subst);
        if (
          rta.kind === "int" ||
          rta.kind === "float" ||
          rta.kind === "var" ||
          rta.kind === "unknown"
        ) {
          return ta;
        }
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "unary - requires number, got " + typeName(rta), {
            expected: "int | float",
            got: typeName(rta),
          }),
        );
        return state.freshVar();
      }
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      const ta = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const tb = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 2, (sub) => unifyOrError(sub, ta, tb, op + " requires matching numeric types"));
      const rta = find(ta, subst);
      const rtb = find(tb, subst);
      const aOk =
        rta.kind === "int" || rta.kind === "float" || rta.kind === "var" || rta.kind === "unknown";
      const bOk =
        rtb.kind === "int" || rtb.kind === "float" || rtb.kind === "var" || rtb.kind === "unknown";
      if (!aOk) {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires number, got " + typeName(rta), {
            expected: "int | float",
            got: typeName(rta),
          }),
        );
      }
      if (!bOk) {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires number, got " + typeName(rtb), {
            expected: "int | float",
            got: typeName(rtb),
          }),
        );
      }
      if (rta.kind === "unknown") return tb;
      return ta;
    }

    // -------------------- type ops --------------------
    case "as": {
      if (!expectArity(ctx, "as", arr, 2)) return state.freshVar();
      const typStr = arr[1];
      if (typeof typStr !== "string") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "as requires a type name string as first arg"),
        );
        return state.freshVar();
      }
      withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      return parseTypeAnnotation(typStr);
    }

    case "is": {
      if (!expectArity(ctx, "is", arr, 2)) return BOOL;
      withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      return BOOL;
    }

    case "untyped": {
      if (arr.length !== 2) {
        addError(ctx, "ARITY_ERROR", "untyped requires 1 arg");
      }
      return UNKNOWN;
    }

    // -------------------- string ops --------------------
    case "str-len": {
      if (!expectArity(ctx, "str-len", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, t, "str-len requires string"));
      return INT;
    }
    case "str-concat": {
      if (!expectArity(ctx, "str-concat", arr, 2)) return STRING;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, a, "str-concat requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, b, "str-concat requires string"));
      return STRING;
    }
    case "str-slice": {
      if (!expectArity(ctx, "str-slice", arr, 3)) return STRING;
      const s = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const a = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const b = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, s, "str-slice requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, a, "str-slice index must be int"));
      withPath(ctx, 3, (sub) => unifyOrError(sub, INT, b, "str-slice index must be int"));
      return STRING;
    }
    case "str-index": {
      if (!expectArity(ctx, "str-index", arr, 2)) return INT;
      const s = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const sub2T = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, s, "str-index requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, sub2T, "str-index requires string"));
      return INT;
    }
    case "str-contains":
    case "str-starts-with":
    case "str-ends-with": {
      if (!expectArity(ctx, op, arr, 2)) return BOOL;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, a, op + " requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, b, op + " requires string"));
      return BOOL;
    }
    case "str-upper":
    case "str-lower":
    case "str-trim": {
      if (!expectArity(ctx, op, arr, 1)) return STRING;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, a, op + " requires string"));
      return STRING;
    }
    case "str-split": {
      if (!expectArity(ctx, "str-split", arr, 2)) return { kind: "array", elem: STRING };
      const s = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const sep = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, s, "str-split requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, sep, "str-split requires string"));
      return { kind: "array", elem: STRING };
    }
    case "str-replace": {
      if (!expectArity(ctx, "str-replace", arr, 3)) return STRING;
      const s = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const a = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const b = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, s, "str-replace requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, a, "str-replace requires string"));
      withPath(ctx, 3, (sub) => unifyOrError(sub, STRING, b, "str-replace requires string"));
      return STRING;
    }
    case "str-get": {
      if (!expectArity(ctx, "str-get", arr, 2)) return INT;
      const s = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const i = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, s, "str-get requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, i, "str-get index must be int"));
      return INT;
    }
    case "str-cmp": {
      if (!expectArity(ctx, "str-cmp", arr, 2)) return INT;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, a, "str-cmp requires string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, b, "str-cmp requires string"));
      return INT;
    }

    // -------------------- array ops --------------------
    case "array": {
      const elem = state.freshVar();
      for (let i = 1; i < arr.length; i++) {
        const t = withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
        withPath(ctx, i, (sub) => unifyOrError(sub, elem, t, "array elements must share a type"));
      }
      return { kind: "array", elem };
    }
    case "array-len": {
      if (!expectArity(ctx, "array-len", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, t, "array-len requires array"),
      );
      return INT;
    }
    case "array-get": {
      if (!expectArity(ctx, "array-get", arr, 2)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const i = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, t, "array-get requires array"),
      );
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, i, "array-get index must be int"));
      return elem;
    }
    case "array-push": {
      if (!expectArity(ctx, "array-push", arr, 2)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elemT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, t, "array-push requires array"),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, elem, elemT, "array-push: element type mismatch"),
      );
      return { kind: "array", elem };
    }
    case "array-pop": {
      if (!expectArity(ctx, "array-pop", arr, 1)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, t, "array-pop requires array"),
      );
      return { kind: "array", elem };
    }
    case "array-slice": {
      if (!expectArityRange(ctx, "array-slice", arr, 2, 3)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const a = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, t, "array-slice requires array"),
      );
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, a, "array-slice index must be int"));
      if (arr.length === 4) {
        const b = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
        withPath(ctx, 3, (sub) => unifyOrError(sub, INT, b, "array-slice index must be int"));
      }
      return { kind: "array", elem };
    }
    case "array-concat": {
      if (!expectArity(ctx, "array-concat", arr, 2)) return state.freshVar();
      const t1 = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const t2 = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      const arrT: MType = { kind: "array", elem };
      withPath(ctx, 1, (sub) => unifyOrError(sub, arrT, t1, "array-concat requires array"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, arrT, t2, "array-concat requires array"));
      return arrT;
    }
    case "concat": {
      if (!expectArity(ctx, "concat", arr, 2)) return state.freshVar();
      const t1 = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const t2 = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      // Polymorphic over array<T> or string
      const r1 = find(t1, subst);
      if (r1.kind === "string") {
        withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, t2, "concat requires string"));
        return STRING;
      }
      if (r1.kind === "array") {
        withPath(ctx, 2, (sub) => unifyOrError(sub, t1, t2, "concat: element type mismatch"));
        return t1;
      }
      // Default: arrays.
      const elem = state.freshVar();
      const arrT: MType = { kind: "array", elem };
      withPath(ctx, 1, (sub) => unifyOrError(sub, arrT, t1, "concat requires array or string"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, arrT, t2, "concat requires array or string"));
      return arrT;
    }
    case "slice": {
      if (!expectArityRange(ctx, "slice", arr, 2, 3)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const a = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, a, "slice index must be int"));
      if (arr.length === 4) {
        const b = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
        withPath(ctx, 3, (sub) => unifyOrError(sub, INT, b, "slice index must be int"));
      }
      const r = find(t, subst);
      if (r.kind === "string") return STRING;
      if (r.kind === "array") return t;
      // var/unknown: assume array<a>.
      const elem = state.freshVar();
      const arrT: MType = { kind: "array", elem };
      withPath(ctx, 1, (sub) => unifyOrError(sub, arrT, t, "slice requires array or string"));
      return arrT;
    }
    case "array-map":
    case "map": {
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      // map can apply to array or record.
      // We pick array by default; record support: detect resolved input type.
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const resolved = find(aT, subst);
      if (op === "map" && resolved.kind === "record") {
        // map over record: fn(v) -> v', preserves keys, all values become v'.
        const inV = state.freshVar();
        const outV = state.freshVar();
        withPath(ctx, 1, (sub) =>
          unifyOrError(sub, { kind: "fn", params: [inV], ret: outV }, fT, op + ": expected fn"),
        );
        // The input record must have all values of type inV.
        const tailIn = state.freshId();
        const allVRowIn: MType = {
          kind: "row",
          fields: new Map(),
          rest: tailIn,
        };
        // We need all fields to be inV. Walk current row, unify each field with inV.
        const flat = resolveRow(resolved.row, subst);
        if (flat.kind === "row") {
          for (const [, v] of flat.fields) {
            withPath(ctx, 2, (sub) => unifyOrError(sub, inV, v, op + ": record field type"));
          }
          // Build output record with same keys but value type outV.
          const outFields = new Map<string, MType>();
          for (const [k] of flat.fields) outFields.set(k, outV);
          return recordOf(outFields, flat.rest);
        }
        // Fallback: treat as open record with all-inV values.
        void allVRowIn;
        return {
          kind: "record",
          row: { kind: "row", fields: new Map(), rest: state.freshId() },
        };
      }
      const inElem = state.freshVar();
      const outElem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "fn", params: [inElem], ret: outElem }, fT, op + ": expected fn"),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem: inElem }, aT, op + ": expected array"),
      );
      return { kind: "array", elem: outElem };
    }
    case "array-filter":
    case "filter": {
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [elem], ret: BOOL },
          fT,
          op + ": expected fn(_) -> bool",
        ),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, op + ": expected array"),
      );
      return { kind: "array", elem };
    }
    case "array-reduce":
    case "reduce": {
      if (!expectArity(ctx, op, arr, 3)) return state.freshVar();
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const initT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const aT = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      const acc = state.freshVar();
      const elem = state.freshVar();
      withPath(ctx, 2, (sub) => unifyOrError(sub, acc, initT, op + " init type"));
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [acc, elem], ret: acc },
          fT,
          op + ": expected fn(acc, elem) -> acc",
        ),
      );
      withPath(ctx, 3, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, op + ": expected array"),
      );
      return acc;
    }
    case "array-find": {
      if (!expectArity(ctx, "array-find", arr, 2)) return state.freshVar();
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [elem], ret: BOOL },
          fT,
          "array-find: expected fn(_) -> bool",
        ),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, "array-find: expected array"),
      );
      return elem;
    }
    case "array-index-of": {
      if (!expectArity(ctx, "array-index-of", arr, 2)) return INT;
      const aT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const eT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, "array-index-of: expected array"),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, elem, eT, "array-index-of: element type mismatch"),
      );
      return INT;
    }
    case "array-includes": {
      if (!expectArity(ctx, "array-includes", arr, 2)) return BOOL;
      const aT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const eT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, "array-includes: expected array"),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, elem, eT, "array-includes: element type mismatch"),
      );
      return BOOL;
    }
    case "array-every":
    case "array-some": {
      if (!expectArity(ctx, op, arr, 2)) return BOOL;
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const elem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          { kind: "fn", params: [elem], ret: BOOL },
          fT,
          op + ": expected fn(_) -> bool",
        ),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem }, aT, op + ": expected array"),
      );
      return BOOL;
    }
    case "array-flat-map": {
      if (!expectArity(ctx, "array-flat-map", arr, 2)) return state.freshVar();
      const fT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const aT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const inElem = state.freshVar();
      const outElem = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(
          sub,
          {
            kind: "fn",
            params: [inElem],
            ret: { kind: "array", elem: outElem },
          },
          fT,
          "array-flat-map: expected fn(_) -> array",
        ),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "array", elem: inElem }, aT, "array-flat-map: expected array"),
      );
      return { kind: "array", elem: outElem };
    }
    case "array-reverse": {
      if (!expectArity(ctx, "array-reverse", arr, 1)) return state.freshVar();
      const aT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elem = state.freshVar();
      const arrT: MType = { kind: "array", elem };
      withPath(ctx, 1, (sub) => unifyOrError(sub, arrT, aT, "array-reverse: expected array"));
      return arrT;
    }
    case "array-sort": {
      if (!expectArityRange(ctx, "array-sort", arr, 1, 2)) return state.freshVar();
      const aT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elem = state.freshVar();
      const arrT: MType = { kind: "array", elem };
      withPath(ctx, 1, (sub) => unifyOrError(sub, arrT, aT, "array-sort: expected array"));
      if (arr.length === 3) {
        const fT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
        withPath(ctx, 2, (sub) =>
          unifyOrError(
            sub,
            { kind: "fn", params: [elem, elem], ret: INT },
            fT,
            "array-sort: comparator must be fn(a,b) -> int",
          ),
        );
      }
      return arrT;
    }

    // -------------------- math ops --------------------
    case "floor":
    case "ceil":
    case "round": {
      if (!expectArity(ctx, op, arr, 1)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const r = find(t, subst);
      if (r.kind !== "int" && r.kind !== "float" && r.kind !== "var" && r.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires number, got " + typeName(r), {
            expected: "int | float",
            got: typeName(r),
          }),
        );
        return state.freshVar();
      }
      if (r.kind === "int") return INT;
      if (r.kind === "float") return INT;
      return INT;
    }
    case "abs": {
      if (!expectArity(ctx, "abs", arr, 1)) return state.freshVar();
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const r = find(t, subst);
      if (r.kind !== "int" && r.kind !== "float" && r.kind !== "var" && r.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "abs requires number, got " + typeName(r), {
            expected: "int | float",
            got: typeName(r),
          }),
        );
        return state.freshVar();
      }
      return t;
    }
    case "sign": {
      if (!expectArity(ctx, "sign", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const r = find(t, subst);
      if (r.kind !== "int" && r.kind !== "float" && r.kind !== "var" && r.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "sign requires number, got " + typeName(r), {
            expected: "int | float",
            got: typeName(r),
          }),
        );
      }
      return INT;
    }
    case "sqrt":
    case "exp":
    case "log":
    case "log2":
    case "log10": {
      if (!expectArity(ctx, op, arr, 1)) return FLOAT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, FLOAT, t, op + " requires float"));
      return FLOAT;
    }
    case "pow": {
      if (!expectArity(ctx, "pow", arr, 2)) return FLOAT;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, FLOAT, a, "pow requires float"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, FLOAT, b, "pow requires float"));
      return FLOAT;
    }
    case "min":
    case "max": {
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 2, (sub) => unifyOrError(sub, a, b, op + " requires matching numeric types"));
      const ra = find(a, subst);
      if (ra.kind !== "int" && ra.kind !== "float" && ra.kind !== "var" && ra.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " requires number, got " + typeName(ra), {
            expected: "int | float",
            got: typeName(ra),
          }),
        );
      }
      return a;
    }
    case "clamp": {
      if (!expectArity(ctx, "clamp", arr, 3)) return state.freshVar();
      const x = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const lo = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      const hi = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      withPath(ctx, 2, (sub) => unifyOrError(sub, x, lo, "clamp: type mismatch"));
      withPath(ctx, 3, (sub) => unifyOrError(sub, x, hi, "clamp: type mismatch"));
      const r = find(x, subst);
      if (r.kind !== "int" && r.kind !== "float" && r.kind !== "var" && r.kind !== "unknown") {
        withPath(ctx, 1, (sub) =>
          addError(sub, "TYPE_MISMATCH", "clamp requires number, got " + typeName(r), {
            expected: "int | float",
            got: typeName(r),
          }),
        );
      }
      return x;
    }

    // -------------------- conversion ops --------------------
    case "count": {
      if (!expectArity(ctx, "count", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const r = find(t, subst);
      if (
        r.kind === "array" ||
        r.kind === "record" ||
        r.kind === "var" ||
        r.kind === "unknown" ||
        r.kind === "string"
      ) {
        return INT;
      }
      withPath(ctx, 1, (sub) =>
        addError(sub, "TYPE_MISMATCH", "count requires array/record/string, got " + typeName(r), {
          expected: "array | record | string",
          got: typeName(r),
        }),
      );
      return INT;
    }
    case "type-of": {
      if (!expectArity(ctx, "type-of", arr, 1)) return STRING;
      withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      return STRING;
    }
    case "to-string": {
      if (!expectArity(ctx, "to-string", arr, 1)) return STRING;
      withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      return STRING;
    }
    case "to-int": {
      if (!expectArity(ctx, "to-int", arr, 1)) return INT;
      withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      return INT;
    }
    case "to-float": {
      if (!expectArity(ctx, "to-float", arr, 1)) return FLOAT;
      withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      return FLOAT;
    }
    case "parse-int": {
      if (!expectArity(ctx, "parse-int", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, t, "parse-int requires string"));
      return INT;
    }
    case "parse-float": {
      if (!expectArity(ctx, "parse-float", arr, 1)) return FLOAT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, t, "parse-float requires string"));
      return FLOAT;
    }
    case "parse-number": {
      if (!expectArity(ctx, "parse-number", arr, 1)) return FLOAT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, STRING, t, "parse-number requires string"));
      return FLOAT;
    }
    case "int->float": {
      if (!expectArity(ctx, "int->float", arr, 1)) return FLOAT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, INT, t, "int->float requires int"));
      return FLOAT;
    }
    case "float->int": {
      if (!expectArity(ctx, "float->int", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, FLOAT, t, "float->int requires float"));
      return INT;
    }

    // -------------------- bitwise ops --------------------
    case "bit-and":
    case "bit-or":
    case "bit-xor":
    case "bit-shl":
    case "bit-shr":
    case "bit-ushr": {
      if (!expectArity(ctx, op, arr, 2)) return INT;
      const a = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const b = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, INT, a, op + " requires int"));
      withPath(ctx, 2, (sub) => unifyOrError(sub, INT, b, op + " requires int"));
      return INT;
    }
    case "bit-not": {
      if (!expectArity(ctx, "bit-not", arr, 1)) return INT;
      const t = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      withPath(ctx, 1, (sub) => unifyOrError(sub, INT, t, "bit-not requires int"));
      return INT;
    }

    // -------------------- record / row ops --------------------
    case "record":
    case "{}": {
      // ["record", [k1, v1], [k2, v2], ...] or ["{}", ...] — closed record literal.
      const fields = new Map<string, MType>();
      for (let i = 1; i < arr.length; i++) {
        const pair = arr[i];
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") {
          withPath(ctx, i, (sub) =>
            addError(sub, "TYPE_MISMATCH", "record entry must be [key, value] with string key"),
          );
          continue;
        }
        const key = pair[0];
        const valT = withPath(ctx, i, (sub) =>
          withPath(sub, 1, (sub2) => infer(pair[1] as Expr, env, sub2)),
        );
        if (fields.has(key)) {
          withPath(ctx, i, (sub) =>
            addError(sub, "TYPE_MISMATCH", "duplicate field in record literal: " + key),
          );
        }
        fields.set(key, valT);
      }
      return recordOf(fields, "empty");
    }

    case "get":
    case "record-get": {
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const keyExpr = arr[2];
      // Allow string literal key for static row constraint.
      if (typeof keyExpr !== "string") {
        // Evaluate the key (must be string), but cannot constrain the row type.
        const kT = withPath(ctx, 2, (sub) => infer(keyExpr as Expr, env, sub));
        withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, kT, op + " key must be string"));
        // Without a static key, just require a record and return unknown.
        const row = state.freshVar();
        withPath(ctx, 1, (sub) =>
          unifyOrError(sub, { kind: "record", row }, rT, op + " requires record"),
        );
        return state.freshVar();
      }
      const fieldT = state.freshVar();
      const expected = openRecordWithField(state, keyExpr, fieldT);
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, expected, rT, op + " requires record with key " + keyExpr),
      );
      return fieldT;
    }

    case "set":
    case "record-set": {
      if (!expectArity(ctx, op, arr, 3)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const keyExpr = arr[2];
      const valT = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      if (typeof keyExpr !== "string") {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", op + " key must be a string literal"),
        );
        return rT;
      }
      const fieldT = state.freshVar();
      const expected = openRecordWithField(state, keyExpr, fieldT);
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, expected, rT, op + " requires record with key " + keyExpr),
      );
      withPath(ctx, 3, (sub) =>
        unifyOrError(sub, fieldT, valT, op + ": value type mismatch for key " + keyExpr),
      );
      return rT;
    }

    case "record-del": {
      if (!expectArity(ctx, "record-del", arr, 2)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const keyExpr = arr[2];
      if (typeof keyExpr !== "string") {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "record-del key must be a string literal"),
        );
        // Still require record-shape for the input.
        const row = state.freshVar();
        withPath(ctx, 1, (sub) =>
          unifyOrError(sub, { kind: "record", row }, rT, "record-del requires record"),
        );
        return rT;
      }
      // Require the input to be a record that has `keyExpr`. For a closed
      // record, this fails if the key is absent (TYPE_MISMATCH). For an open
      // record, the row var absorbs the field — succeeds either way.
      const fieldT = state.freshVar();
      const expected = openRecordWithField(state, keyExpr, fieldT);
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, expected, rT, "record-del: missing key " + keyExpr),
      );
      return rT;
    }

    case "get-in": {
      if (!expectArity(ctx, "get-in", arr, 2)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const pathExpr = arr[2];
      // Must be array of string|int. We can't constrain row types deeply unless
      // path is a literal array of string literals.
      if (!Array.isArray(pathExpr)) {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "get-in path must be an array literal"),
        );
        return state.freshVar();
      }
      // If the path is a literal array (["array", k1, k2, ...] or just a JSON array literal in spec),
      // walk it. Spec uses array<string|number>. If first elem is "array", treat it like such.
      let segments: Expr[] = pathExpr;
      if (segments.length > 0 && segments[0] === "array") segments = segments.slice(1);
      // Walk through the row.
      let cur: MType = rT;
      for (const seg of segments) {
        if (typeof seg === "string") {
          const fieldT = state.freshVar();
          const expected = openRecordWithField(state, seg, fieldT);
          withPath(ctx, 1, (sub) => unifyOrError(sub, expected, cur, "get-in: missing key " + seg));
          cur = fieldT;
        } else if (typeof seg === "number") {
          const elem = state.freshVar();
          withPath(ctx, 1, (sub) =>
            unifyOrError(sub, { kind: "array", elem }, cur, "get-in: index requires array"),
          );
          cur = elem;
        } else {
          // dynamic path segment — give up structurally
          return state.freshVar();
        }
      }
      return cur;
    }

    case "set-in": {
      if (!expectArity(ctx, "set-in", arr, 3)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const pathExpr = arr[2];
      const valT = withPath(ctx, 3, (sub) => infer(at(arr, 3), env, sub));
      if (!Array.isArray(pathExpr)) {
        withPath(ctx, 2, (sub) =>
          addError(sub, "TYPE_MISMATCH", "set-in path must be an array literal"),
        );
        return rT;
      }
      let segments: Expr[] = pathExpr;
      if (segments.length > 0 && segments[0] === "array") segments = segments.slice(1);
      let cur: MType = rT;
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        const isLast = si === segments.length - 1;
        if (typeof seg === "string") {
          const fieldT = isLast ? valT : state.freshVar();
          const expected = openRecordWithField(state, seg, fieldT);
          withPath(ctx, 1, (sub) => unifyOrError(sub, expected, cur, "set-in: missing key " + seg));
          cur = fieldT;
        } else if (typeof seg === "number") {
          const elem = isLast ? valT : state.freshVar();
          withPath(ctx, 1, (sub) =>
            unifyOrError(sub, { kind: "array", elem }, cur, "set-in: index requires array"),
          );
          cur = elem;
        } else {
          return rT;
        }
      }
      return rT;
    }

    case "merge":
    case "record-merge": {
      if (!expectArity(ctx, op, arr, 2)) return state.freshVar();
      const aT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const bT = withPath(ctx, 2, (sub) => infer(at(arr, 2), env, sub));
      // Both must be records. Result is a closed record with all keys from both,
      // b winning on conflict.
      const rowA = state.freshVar();
      const rowB = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "record", row: rowA }, aT, op + ": expected record"),
      );
      withPath(ctx, 2, (sub) =>
        unifyOrError(sub, { kind: "record", row: rowB }, bT, op + ": expected record"),
      );
      // Try to compute merged row from zonked sides.
      const za = zonk(aT, subst);
      const zb = zonk(bT, subst);
      if (za.kind === "record" && zb.kind === "record") {
        const ra = resolveRow(za.row, subst);
        const rb = resolveRow(zb.row, subst);
        if (ra.kind === "row" && rb.kind === "row") {
          const merged = new Map<string, MType>(ra.fields);
          for (const [k, v] of rb.fields) merged.set(k, v);
          // If both closed, result is closed; else open with fresh tail.
          if (ra.rest === "empty" && rb.rest === "empty") {
            return recordOf(merged, "empty");
          }
          return recordOf(merged, state.freshId());
        }
      }
      // Fallback: fully open record.
      return {
        kind: "record",
        row: { kind: "row", fields: new Map(), rest: state.freshId() },
      };
    }

    case "keys":
    case "record-keys": {
      if (!expectArity(ctx, op, arr, 1)) return { kind: "array", elem: STRING };
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const row = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "record", row }, rT, op + ": expected record"),
      );
      return { kind: "array", elem: STRING };
    }

    case "vals":
    case "record-vals": {
      if (!expectArity(ctx, op, arr, 1)) return state.freshVar();
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const elem = state.freshVar();
      const row = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "record", row }, rT, op + ": expected record"),
      );
      // Walk current fields and unify each with elem (consistent unification).
      const z = zonk(rT, subst);
      if (z.kind === "record") {
        const flat = resolveRow(z.row, subst);
        if (flat.kind === "row") {
          for (const [, v] of flat.fields) {
            withPath(ctx, 1, (sub) => unifyOrError(sub, elem, v, op + ": value type"));
          }
        }
      }
      return { kind: "array", elem };
    }

    case "record-has": {
      if (!expectArity(ctx, "record-has", arr, 2)) return BOOL;
      const rT = withPath(ctx, 1, (sub) => infer(at(arr, 1), env, sub));
      const row = state.freshVar();
      withPath(ctx, 1, (sub) =>
        unifyOrError(sub, { kind: "record", row }, rT, "record-has: expected record"),
      );
      const keyExpr = arr[2];
      if (typeof keyExpr !== "string") {
        const kT = withPath(ctx, 2, (sub) => infer(keyExpr as Expr, env, sub));
        withPath(ctx, 2, (sub) => unifyOrError(sub, STRING, kT, "record-has: key must be string"));
      }
      return BOOL;
    }

    // -------------------- match (DU pattern matching) --------------------
    case "match": {
      return inferMatch(arr, env, ctx);
    }

    // -------------------- algebraic effects --------------------
    case "perform": {
      return inferPerform(arr, env, ctx);
    }
    case "handle": {
      return inferHandle(arr, env, ctx);
    }

    // -------------------- capabilities --------------------
    case "call.method": {
      return inferCallMethod(arr, env, ctx);
    }

    // -------------------- optimizer-introduced ops --------------------
    // `__native` and `__loop`/`__continue` are produced by optimizer passes
    // (loop recognition / TCO). They are not user-facing, but TypeInfo may
    // be requested on already-optimized expressions (e.g. for purity-gated
    // fusion). We typecheck sub-expressions so per-path types/effects are
    // recorded, but otherwise treat the result as an unknown type with no
    // additional effects (the natives table itself is pure for the array_*
    // ops; if the user-supplied function arg performs effects, those are
    // recorded under that arg's path during its inference).
    case "__native": {
      // arr[1] is the native name (string literal, no inference).
      for (let i = 2; i < arr.length; i++) {
        withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
      }
      return ctx.state.freshVar();
    }
    case "__loop": {
      const initArgs = arr[2];
      if (Array.isArray(initArgs)) {
        for (let i = 0; i < initArgs.length; i++) {
          withPath(ctx, 2, (sub) =>
            withPath(sub, i, (sub2) => infer(initArgs[i] as Expr, env, sub2)),
          );
        }
      }
      // Body is inferred under fresh param bindings — but for TypeInfo
      // purposes we just need to populate the index. Use fresh vars.
      const params = arr[1];
      const paramBindings: Record<string, MType> = {};
      if (Array.isArray(params)) {
        for (const p of params) {
          if (typeof p === "string") {
            paramBindings[p] = ctx.state.freshVar();
          }
        }
      }
      const bodyEnv = env.extend(paramBindings);
      withPath(ctx, 3, (sub) => infer(at(arr, 3), bodyEnv, sub));
      return ctx.state.freshVar();
    }
    case "__continue": {
      for (let i = 1; i < arr.length; i++) {
        withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
      }
      return ctx.state.freshVar();
    }
    case "__lit": {
      return ctx.state.freshVar();
    }

    // -------------------- Phase 6+ ops (still TBD) --------------------
    case "?": {
      for (let i = 1; i < arr.length; i++) {
        withPath(ctx, i, (sub) => infer(at(arr, i), env, sub));
      }
      return notYetImplemented(ctx, op);
    }

    default: {
      addError(ctx, "UNKNOWN_OP", "unknown op: " + op);
      return ctx.state.freshVar();
    }
  }
}

// ---------------------------------------------------------------------------
// Linearity pass (Phase 6)
// ---------------------------------------------------------------------------
//
// Opt-in linear/affine usage checker. Runs *after* HM inference completes —
// types are zonked, so we can ask questions like "is this binding linear?"
// without worrying about unification residue.
//
// Strategy: a usage-counting walk over the AST. The pass tracks declared
// linear/affine bindings only. References to non-linear values, and code that
// uses no linear types at all, pay no overhead.
//
// Branching (`if`, `cond`, `match`): each branch is walked with a snapshot of
// the relevant entries, then we merge by taking the MAX uses across branches.
// Conservative: if any branch uses a linear value twice, that's an error.
//
// Function bodies: a fn is its own scope; linear params are checked at the
// end of the body. Capturing an outer linear variable counts as one use of
// that outer var per syntactic occurrence — we don't model "fn called N
// times". This matches the conservative-safe-choice rule.
//
// Errors: DROPPED_LINEAR (zero uses), DUPLICATED_LINEAR (>1 use of linear),
// DUPLICATED_AFFINE (>1 use of affine).

type Linearity = "linear" | "affine";

type UsageEntry = {
  /** Original linearity classification — drives which errors apply. */
  linearity: Linearity;
  uses: number;
  /** Source path of the *binder*, for error reporting. */
  bindPath: number[];
  /** Display name of the binder, for error messages. */
  name: string;
  /**
   * True when the linearity comes from an explicit `linear`/`affine` type
   * annotation. False for capability-derived linearity (`Cap<T>`). Only
   * explicit-linear entries trigger LINEAR_CAPTURED_BY_FN / LINEAR_IN_LETREC.
   */
  explicit: boolean;
};

/**
 * Scope of usage tracking. Entries are looked up by name walking up the parent
 * chain. Entries are mutated in place during the walk.
 */
type UsageScope = {
  entries: Map<string, UsageEntry>;
  parent: UsageScope | null;
};

function lookupUsage(scope: UsageScope, name: string): UsageEntry | undefined {
  let s: UsageScope | null = scope;
  while (s !== null) {
    const e = s.entries.get(name);
    if (e !== undefined) return e;
    s = s.parent;
  }
  return undefined;
}

/**
 * Classify a (zonked) MType as linear, affine, or unrestricted. `Cap<T>` is
 * treated as linear by default per spec — capabilities cannot be silently
 * copied or dropped.
 *
 * `unknown` is conservatively treated as non-linear (gradual escape). The
 * spec carves out `linear unknown` as a distinct type — that case is handled
 * by the explicit `linear` wrapper.
 */
function classifyLinearity(t: MType): Linearity | null {
  switch (t.kind) {
    case "linear":
      return "linear";
    case "affine":
      return "affine";
    case "named":
      // Capabilities are linear by default per spec.
      if (t.name === "Cap") return "linear";
      return null;
    default:
      return null;
  }
}

/**
 * True when the type carries explicit `linear`/`affine` annotation.
 * Cap-derived linearity is NOT explicit — capabilities may be freely captured
 * in closures without triggering LINEAR_CAPTURED_BY_FN / LINEAR_IN_LETREC.
 */
function isExplicitLinear(t: MType): boolean {
  return t.kind === "linear" || t.kind === "affine";
}

/**
 * Snapshot the `uses` field of every entry reachable through the scope chain.
 * Used by branching constructs so we can run each branch from the same
 * starting point and then merge with MAX.
 */
function snapshotUses(scope: UsageScope): Map<UsageEntry, number> {
  const snap = new Map<UsageEntry, number>();
  let s: UsageScope | null = scope;
  while (s !== null) {
    for (const e of s.entries.values()) {
      if (!snap.has(e)) snap.set(e, e.uses);
    }
    s = s.parent;
  }
  return snap;
}

function restoreUses(snap: Map<UsageEntry, number>): void {
  for (const [e, n] of snap) e.uses = n;
}

function maxMergeUses(target: Map<UsageEntry, number>, snap: Map<UsageEntry, number>): void {
  for (const [e, n] of snap) {
    const cur = target.get(e);
    if (cur === undefined || n > cur) target.set(e, n);
  }
}

/**
 * Walk a list of branch bodies. Each branch starts from the same usage
 * snapshot; afterwards each entry's `uses` becomes the MAX across branches.
 *
 * `runBranch` takes a setup callback (typically running the branch's walker)
 * and is called once per branch.
 */
function withBranches(scope: UsageScope, branches: Array<() => void>): void {
  if (branches.length === 0) return;
  const baseline = snapshotUses(scope);
  const merged = new Map<UsageEntry, number>(baseline);
  for (const run of branches) {
    restoreUses(baseline);
    run();
    const after = snapshotUses(scope);
    maxMergeUses(merged, after);
  }
  restoreUses(merged);
}

type LinCtx = {
  errors: TypecheckError[];
  path: number[];
  state: State;
  ctors: Map<string, string>;
  typeDefs: Map<string, TypeDefInfo>;
  effectSigs: Map<string, EffectSig>;
  capMethods: Map<string, Map<string, CapMethodSig>>;
};

/**
 * Determine the (zonked) type of an expression in a given env. Used by the
 * linearity pass to discover whether a `let`-bound RHS produces a linear or
 * affine value. Runs `infer` against a throwaway error buffer — any new
 * errors produced are discarded since HM already validated the program.
 */
function probeType(expr: Expr, env: TypeEnv, ctx: LinCtx): MType {
  const sub: Ctx = {
    errors: [],
    path: [],
    state: ctx.state,
    typeDefs: ctx.typeDefs,
    ctors: ctx.ctors,
    effectSigs: ctx.effectSigs,
    capMethods: ctx.capMethods,
    currentEffects: freshEffectsRow(ctx.state),
  };
  const t = infer(expr, env, sub);
  return zonk(t, ctx.state.subst);
}

function linAddError(
  ctx: LinCtx,
  code: string,
  message: string,
  path: number[],
  extras?: { expected?: string; got?: string },
): void {
  ctx.errors.push({ code, path: [...path], message, ...extras });
}

/**
 * Final check on a binding leaving scope: emit DROPPED_LINEAR or
 * DUPLICATED_LINEAR / DUPLICATED_AFFINE based on the entry's final use count.
 */
function checkBindingFinal(ctx: LinCtx, entry: UsageEntry): void {
  if (entry.linearity === "linear") {
    if (entry.uses === 0) {
      linAddError(
        ctx,
        "DROPPED_LINEAR",
        "linear value '" + entry.name + "' is never used (must be used exactly once)",
        entry.bindPath,
      );
    } else if (entry.uses > 1) {
      linAddError(
        ctx,
        "DUPLICATED_LINEAR",
        "linear value '" +
          entry.name +
          "' is used " +
          String(entry.uses) +
          " times (must be used exactly once)",
        entry.bindPath,
      );
    }
  } else {
    // affine: at most once
    if (entry.uses > 1) {
      linAddError(
        ctx,
        "DUPLICATED_AFFINE",
        "affine value '" +
          entry.name +
          "' is used " +
          String(entry.uses) +
          " times (must be used at most once)",
        entry.bindPath,
      );
    }
  }
}

function withLinPath<T>(ctx: LinCtx, idx: number, fn: (sub: LinCtx) => T): T {
  const sub: LinCtx = {
    errors: ctx.errors,
    path: [...ctx.path, idx],
    state: ctx.state,
    ctors: ctx.ctors,
    typeDefs: ctx.typeDefs,
    effectSigs: ctx.effectSigs,
    capMethods: ctx.capMethods,
  };
  return fn(sub);
}

/**
 * Collect all UsageEntry objects from `scope` that are referenced (as free
 * variables) inside `expr`, excluding names that are locally bound within
 * `expr`. Each unique entry is returned at most once.
 *
 * Used to detect linear captures inside `fn` / `fn-once` bodies and `letrec`
 * RHSs without running the full usage-counting walk.
 */
function collectFreeLinearRefs(
  expr: Expr,
  scope: UsageScope,
  locallyBound: Set<string>,
): UsageEntry[] {
  const found = new Map<UsageEntry, true>();
  function scan(e: Expr, bound: Set<string>): void {
    if (e === null || typeof e === "boolean" || typeof e === "number") return;
    if (typeof e === "string") {
      if (bound.has(e)) return;
      const entry = lookupUsage(scope, e);
      // Only collect explicit linear/affine captures — not capability-linear.
      if (entry !== undefined && entry.explicit) found.set(entry, true);
      return;
    }
    if (!Array.isArray(e) || e.length === 0) return;
    const head = e[0];
    if (typeof head !== "string") return;
    // Track new binders introduced by let / letrec / fn / fn-once / match to
    // correctly exclude shadowed names.
    if (head === "let" && e.length === 3) {
      const bindings = e[1];
      let cur = bound;
      if (Array.isArray(bindings)) {
        for (const b of bindings) {
          if (Array.isArray(b) && b.length === 2) {
            scan(b[1] as Expr, cur);
            if (typeof b[0] === "string") {
              cur = new Set(cur);
              cur.add(b[0] as string);
            }
          }
        }
      }
      scan(e[2] as Expr, cur);
      return;
    }
    if (head === "letrec" && e.length === 3) {
      const bindings = e[1];
      let cur = bound;
      if (Array.isArray(bindings)) {
        for (const b of bindings) {
          if (Array.isArray(b) && b.length === 2 && typeof b[0] === "string") {
            cur = new Set(cur);
            cur.add(b[0] as string);
          }
        }
        for (const b of bindings) {
          if (Array.isArray(b) && b.length === 2) {
            scan(b[1] as Expr, cur);
          }
        }
      }
      scan(e[2] as Expr, cur);
      return;
    }
    if ((head === "fn" || head === "fn-once") && e.length === 3) {
      const params = e[1];
      let cur = bound;
      if (Array.isArray(params)) {
        for (const p of params) {
          let pname: string | null = null;
          if (typeof p === "string") pname = p;
          else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") pname = p[0];
          if (pname !== null) {
            cur = new Set(cur);
            cur.add(pname);
          }
        }
      }
      scan(e[2] as Expr, cur);
      return;
    }
    if (head === "match" && e.length >= 3) {
      scan(e[1] as Expr, bound);
      for (let i = 2; i < e.length; i++) {
        const clause = e[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const pattern = clause[0];
        let branchBound = bound;
        if (Array.isArray(pattern) && pattern.length >= 1 && typeof pattern[0] === "string") {
          for (let j = 1; j < pattern.length; j++) {
            if (typeof pattern[j] === "string" && pattern[j] !== "_") {
              branchBound = new Set(branchBound);
              branchBound.add(pattern[j] as string);
            }
          }
        }
        scan(clause[1] as Expr, branchBound);
      }
      return;
    }
    // Default: recurse into all children.
    for (let i = 1; i < e.length; i++) scan(e[i] as Expr, bound);
  }
  scan(expr, locallyBound);
  return Array.from(found.keys());
}

/**
 * Walk an expression in linearity mode, accumulating use counts on `scope`.
 *
 * The walker mirrors `infer` structurally but is independent — it only cares
 * about variable references (use sites) and the binders that introduce
 * tracked names (let, letrec, fn params, match patterns).
 *
 * For ops we don't need to special-case (most builtins), the default child
 * walk is fine: just recurse into every child sub-expression.
 */
function walkLin(expr: Expr, scope: UsageScope, env: TypeEnv, ctx: LinCtx): void {
  if (expr === null || typeof expr === "boolean" || typeof expr === "number") return;
  if (typeof expr === "string") {
    // Variable reference — increment the matching usage entry, if tracked.
    const entry = lookupUsage(scope, expr);
    if (entry !== undefined) entry.uses += 1;
    return;
  }

  const arr = expr as Expr[];
  if (arr.length === 0) return;
  const op = arr[0];
  if (typeof op !== "string") return;

  // Variant constructors and unknown ops just recurse into children.
  if (isUpperCase(op)) {
    for (let i = 1; i < arr.length; i++) {
      withLinPath(ctx, i, (sub) => walkLin(at(arr, i), scope, env, sub));
    }
    return;
  }

  switch (op) {
    case "if": {
      if (arr.length !== 4) return;
      withLinPath(ctx, 1, (sub) => walkLin(at(arr, 1), scope, env, sub));
      withBranches(scope, [
        () => withLinPath(ctx, 2, (sub) => walkLin(at(arr, 2), scope, env, sub)),
        () => withLinPath(ctx, 3, (sub) => walkLin(at(arr, 3), scope, env, sub)),
      ]);
      return;
    }
    case "cond": {
      // Tests run unconditionally (sequentially); branches merge via MAX.
      const branches: Array<() => void> = [];
      for (let i = 1; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const test = clause[0];
        const body = clause[1] as Expr;
        if (test !== "else") {
          withLinPath(ctx, i, (sub) =>
            withLinPath(sub, 0, (sub2) => walkLin(test as Expr, scope, env, sub2)),
          );
        }
        const idx = i;
        branches.push(() =>
          withLinPath(ctx, idx, (sub) =>
            withLinPath(sub, 1, (sub2) => walkLin(body, scope, env, sub2)),
          ),
        );
      }
      withBranches(scope, branches);
      return;
    }
    case "do": {
      for (let i = 1; i < arr.length; i++) {
        withLinPath(ctx, i, (sub) => walkLin(at(arr, i), scope, env, sub));
      }
      return;
    }
    case "let": {
      if (arr.length !== 3) return;
      const bindings = arr[1];
      if (!Array.isArray(bindings)) return;
      const introduced: UsageEntry[] = [];
      let curEnv = env;
      let curScope = scope;
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        if (!Array.isArray(b) || b.length !== 2) continue;
        const name = b[0];
        if (typeof name !== "string") continue;
        // Walk the binding RHS in the *current* scope/env (sequential let).
        withLinPath(ctx, 1, (sub) =>
          withLinPath(sub, i, (sub2) => walkLin(b[1] as Expr, curScope, curEnv, sub2)),
        );
        // Decide whether the binding itself is linear/affine. Probe the RHS
        // type via a fresh inference run (state is shared so substitution
        // already settled by HM is reused).
        const rhsT = probeType(b[1] as Expr, curEnv, ctx);
        const body = rhsT.kind === "scheme" ? rhsT.body : rhsT;
        const lin = classifyLinearity(body);
        if (lin !== null) {
          const entry: UsageEntry = {
            linearity: lin,
            uses: 0,
            bindPath: [...ctx.path, 1, i],
            name,
            explicit: isExplicitLinear(body),
          };
          curScope = {
            entries: new Map([[name, entry]]),
            parent: curScope,
          };
          introduced.push(entry);
        }
        // Extend env with the binding's type so subsequent RHSs and the body
        // resolve `name`.
        curEnv = curEnv.extend({ [name]: rhsT });
      }
      withLinPath(ctx, 2, (sub) => walkLin(at(arr, 2), curScope, curEnv, sub));
      for (const e of introduced) checkBindingFinal(ctx, e);
      return;
    }
    case "letrec": {
      if (arr.length !== 3) return;
      const bindings = arr[1];
      if (!Array.isArray(bindings)) return;
      // For letrec we don't attempt to model linear recursive bindings —
      // walk all RHSs and the body in the same scope. Linear bindings declared
      // in letrec are checked the same way.
      //
      // Outer-scope linear values must NOT appear in any letrec RHS: call
      // count through mutual recursion is undecidable.
      const introduced: UsageEntry[] = [];
      let curScope = scope;
      // First, allocate fresh placeholders so all RHS probes can see the
      // names. Then probe each RHS to detect linearity.
      const placeholders: Record<string, MType> = {};
      const recNames = new Set<string>();
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        if (!Array.isArray(b) || b.length !== 2) continue;
        const name = b[0];
        if (typeof name !== "string") continue;
        placeholders[name] = ctx.state.freshVar();
        recNames.add(name);
      }
      const recEnv = env.extend(placeholders);
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        if (!Array.isArray(b) || b.length !== 2) continue;
        const name = b[0];
        if (typeof name !== "string") continue;
        const rhsT = probeType(b[1] as Expr, recEnv, ctx);
        const body = rhsT.kind === "scheme" ? rhsT.body : rhsT;
        const lin = classifyLinearity(body);
        if (lin !== null) {
          const entry: UsageEntry = {
            linearity: lin,
            uses: 0,
            bindPath: [...ctx.path, 1, i],
            name,
            explicit: isExplicitLinear(body),
          };
          curScope = { entries: new Map([[name, entry]]), parent: curScope };
          introduced.push(entry);
        }
      }
      // Check each RHS for outer linear captures before walking.
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        if (!Array.isArray(b) || b.length !== 2) continue;
        const outerCaptures = collectFreeLinearRefs(b[1] as Expr, scope, recNames);
        for (const cap of outerCaptures) {
          withLinPath(ctx, 1, (sub) =>
            withLinPath(sub, i, (sub2) =>
              linAddError(
                sub2,
                "LINEAR_IN_LETREC",
                "linear value '" +
                  cap.name +
                  "' cannot be referenced in a letrec RHS (call count is undecidable)",
                sub2.path,
              ),
            ),
          );
        }
      }
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        if (!Array.isArray(b) || b.length !== 2) continue;
        withLinPath(ctx, 1, (sub) =>
          withLinPath(sub, i, (sub2) => walkLin(b[1] as Expr, curScope, recEnv, sub2)),
        );
      }
      withLinPath(ctx, 2, (sub) => walkLin(at(arr, 2), curScope, recEnv, sub));
      for (const e of introduced) checkBindingFinal(ctx, e);
      return;
    }
    case "fn":
    case "fn-once": {
      if (arr.length !== 3) return;
      const paramsExpr = arr[1];
      if (!Array.isArray(paramsExpr)) return;
      // Collect param names for capture detection (params shadow outer vars).
      const paramNames = new Set<string>();
      const introduced: UsageEntry[] = [];
      let bodyScope: UsageScope = { entries: new Map(), parent: scope };
      for (let i = 0; i < paramsExpr.length; i++) {
        const p = paramsExpr[i];
        let pname: string | null = null;
        let ptype: MType | null = null;
        if (typeof p === "string") {
          pname = p;
        } else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") {
          pname = p[0];
          if (p.length >= 2 && typeof p[1] === "string") {
            ptype = parseTypeAnnotation(p[1] as string);
          }
        }
        if (pname === null) continue;
        paramNames.add(pname);
        if (ptype === null) continue;
        const lin = classifyLinearity(ptype);
        if (lin !== null) {
          const entry: UsageEntry = {
            linearity: lin,
            uses: 0,
            bindPath: [...ctx.path, 1, i],
            name: pname,
            explicit: isExplicitLinear(ptype),
          };
          bodyScope.entries.set(pname, entry);
          introduced.push(entry);
        }
      }
      // Detect outer-scope explicit-linear captures in the body.
      // Uses collectFreeLinearRefs to find which outer explicit-linear entries
      // are referenced (considering inner binders that shadow names).
      const outerCaptures = collectFreeLinearRefs(at(arr, 2), scope, paramNames);
      if (op === "fn") {
        // Regular fn must not capture outer explicit-linear values — call count
        // is unknown, so we cannot guarantee exactly-once use.
        for (const cap of outerCaptures) {
          withLinPath(ctx, 2, (sub) =>
            linAddError(
              sub,
              "LINEAR_CAPTURED_BY_FN",
              "linear value '" +
                cap.name +
                "' cannot be captured by a regular fn (use fn-once for single-call closures)",
              sub.path,
            ),
          );
        }
        // Snapshot outer explicit-linear entries before body walk so we can
        // restore their counts — we've already emitted errors; don't let them
        // accidentally satisfy the "used once" check via the body walk.
        const snapBefore = new Map<UsageEntry, number>();
        for (const cap of outerCaptures) snapBefore.set(cap, cap.uses);
        withLinPath(ctx, 2, (sub) => walkLin(at(arr, 2), bodyScope, env, sub));
        // Restore outer explicit-linear entry counts.
        for (const [cap, n] of snapBefore) cap.uses = n;
      } else {
        // fn-once: snapshot outer explicit-linear entries before body walk,
        // then clamp each to pre-walk + 1 (captured once at definition site).
        const snapBefore = new Map<UsageEntry, number>();
        for (const cap of outerCaptures) snapBefore.set(cap, cap.uses);
        withLinPath(ctx, 2, (sub) => walkLin(at(arr, 2), bodyScope, env, sub));
        for (const [cap, n] of snapBefore) cap.uses = n + 1;
      }
      for (const e of introduced) checkBindingFinal(ctx, e);
      return;
    }
    case "match": {
      if (arr.length < 3) return;
      // Walk scrutinee — references in the scrutinee count (consume the
      // value being matched, including any tracked outer linear).
      withLinPath(ctx, 1, (sub) => walkLin(at(arr, 1), scope, env, sub));
      const branches: Array<() => void> = [];
      for (let i = 2; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const pattern = clause[0];
        const body = clause[1] as Expr;
        const idx = i;
        branches.push(() => {
          // Pattern bindings: extend the scope with any field bindings whose
          // type is linear/affine. We use the post-inference field types when
          // available via the constructor table.
          const introduced: UsageEntry[] = [];
          let branchScope: UsageScope = { entries: new Map(), parent: scope };
          if (
            Array.isArray(pattern) &&
            pattern.length >= 1 &&
            typeof pattern[0] === "string" &&
            isUpperCase(pattern[0])
          ) {
            const tag = pattern[0];
            const typeName_ = ctx.ctors.get(tag);
            const def = typeName_ === undefined ? undefined : ctx.typeDefs.get(typeName_);
            if (def !== undefined) {
              const fieldTs = def.variants.get(tag) ?? [];
              for (let j = 1; j < pattern.length; j++) {
                const bname = pattern[j];
                if (typeof bname !== "string" || bname === "_") continue;
                const ft = fieldTs[j - 1];
                if (ft === undefined) continue;
                const lin = classifyLinearity(ft);
                if (lin !== null) {
                  const entry: UsageEntry = {
                    linearity: lin,
                    uses: 0,
                    bindPath: [...ctx.path, idx, 0, j],
                    name: bname,
                    explicit: isExplicitLinear(ft),
                  };
                  branchScope.entries.set(bname, entry);
                  introduced.push(entry);
                }
              }
            }
          }
          withLinPath(ctx, idx, (sub) =>
            withLinPath(sub, 1, (sub2) => walkLin(body, branchScope, env, sub2)),
          );
          for (const e of introduced) checkBindingFinal(ctx, e);
        });
      }
      withBranches(scope, branches);
      return;
    }
    case "handle": {
      // Body executes; clauses execute when their tag is performed (treated
      // as alternative branches). Conservative: walk body unconditionally,
      // walk each clause body as a branch.
      if (arr.length < 2) return;
      withLinPath(ctx, 1, (sub) => walkLin(at(arr, 1), scope, env, sub));
      const branches: Array<() => void> = [];
      for (let i = 2; i < arr.length; i++) {
        const clause = arr[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const body = clause[1] as Expr;
        const idx = i;
        branches.push(() =>
          withLinPath(ctx, idx, (sub) =>
            withLinPath(sub, 1, (sub2) => walkLin(body, scope, env, sub2)),
          ),
        );
      }
      // Note: the clause body running is mutually-exclusive *relative to the
      // body completing without the handler firing* — but for conservative
      // enforcement we treat clauses as alternatives to one another (MAX
      // merge), which is a sound over-approximation for the "used at most
      // once per dynamic execution" intent.
      if (branches.length > 0) withBranches(scope, branches);
      return;
    }
    default: {
      // Generic op: just recurse into all children.
      for (let i = 1; i < arr.length; i++) {
        withLinPath(ctx, i, (sub) => walkLin(at(arr, i), scope, env, sub));
      }
      return;
    }
  }
}

/**
 * Run the linearity pass over an expression. Top-level linear bindings (from
 * the initial env) become tracked entries on the root scope and are checked
 * after the walk completes.
 */
function runLinearityPass(expr: Expr, env: TypeEnv, ctx: LinCtx): void {
  // Build a root scope with entries for any initial-env binding whose
  // (zonked) type is linear/affine. Any reference to those names in the
  // top-level expression counts; at the end we run the same final check.
  const rootEntries = new Map<string, UsageEntry>();
  const introduced: UsageEntry[] = [];
  for (const t of env.allBindings()) void t; // touch to keep import warnings quiet
  // We need names — but TypeEnv only exposes types via allBindings(). Walk
  // the chain manually using a small helper.
  const seen = new Set<string>();
  const walkEnv = (e: TypeEnv | null): void => {
    if (e === null) return;
    // Access private bindings through a duck-typed cast — keeps the public
    // TypeEnv API minimal.
    const inner = (e as unknown as { bindings: Map<string, MType>; parent: TypeEnv | null })
      .bindings;
    for (const [name, t] of inner) {
      if (seen.has(name)) continue;
      seen.add(name);
      const z = zonk(t, ctx.state.subst);
      const body = z.kind === "scheme" ? z.body : z;
      const lin = classifyLinearity(body);
      if (lin !== null) {
        const entry: UsageEntry = {
          linearity: lin,
          uses: 0,
          bindPath: [],
          name,
          explicit: isExplicitLinear(body),
        };
        rootEntries.set(name, entry);
        introduced.push(entry);
      }
    }
    walkEnv((e as unknown as { parent: TypeEnv | null }).parent);
  };
  walkEnv(env);

  const root: UsageScope = { entries: rootEntries, parent: null };
  walkLin(expr, root, env, ctx);
  for (const e of introduced) checkBindingFinal(ctx, e);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function typecheck(expr: Expr, env?: TypeEnv): TypecheckResult {
  const state = new State();
  // Standalone typecheck still gets the std DUs (option/result) so that bare
  // expressions referencing Some/None/Ok/Err typecheck without a module wrapper.
  const { typeDefs, ctors } = makeStdTypeDefs();
  const effectSigs = makeStdEffectSigs(state);
  const ctx: Ctx = {
    errors: [],
    path: [],
    state,
    typeDefs,
    ctors,
    effectSigs,
    capMethods: makeBuiltinCapMethods(),
    currentEffects: freshEffectsRow(state),
  };
  const useEnv = env ?? EMPTY_TYPE_ENV;
  const t = infer(expr, useEnv, ctx);
  // Linearity pass runs only if HM inference succeeded — running it on a
  // partially-typed program would just produce noisy follow-on errors.
  if (ctx.errors.length === 0) {
    const linCtx: LinCtx = {
      errors: ctx.errors,
      path: [],
      state,
      ctors,
      typeDefs,
      effectSigs,
      capMethods: ctx.capMethods,
    };
    runLinearityPass(expr, useEnv, linCtx);
  }
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, type: zonk(t, state.subst) };
}

// ---------------------------------------------------------------------------
// Module typechecking
// ---------------------------------------------------------------------------

/**
 * Build the standard `option<T>` and `result<T, E>` type definitions.
 * Field types use `{kind:"named", name:"<paramName>", args:[]}` as
 * placeholders for the type parameters; these are replaced by fresh vars
 * at each constructor / pattern instantiation site.
 */
function makeStdTypeDefs(): {
  typeDefs: Map<string, TypeDefInfo>;
  ctors: Map<string, string>;
} {
  const typeDefs = new Map<string, TypeDefInfo>();
  const ctors = new Map<string, string>();

  const optionVariants = new Map<string, MType[]>();
  optionVariants.set("None", []);
  optionVariants.set("Some", [{ kind: "named", name: "T", args: [] }]);
  typeDefs.set("option", { params: ["T"], variants: optionVariants });
  ctors.set("None", "option");
  ctors.set("Some", "option");

  const resultVariants = new Map<string, MType[]>();
  resultVariants.set("Ok", [{ kind: "named", name: "T", args: [] }]);
  resultVariants.set("Err", [{ kind: "named", name: "E", args: [] }]);
  typeDefs.set("result", { params: ["T", "E"], variants: resultVariants });
  ctors.set("Ok", "result");
  ctors.set("Err", "result");

  return { typeDefs, ctors };
}

/**
 * Build the standard effect signatures (`Error`, `Async`, `Yield`).
 *
 * The spec does not pin payload/resume types, so each gets fresh vars at
 * program scope. Within a single typecheck run, all uses of e.g. `Error`
 * unify against the same payload/resume — across runs they are independent.
 *
 * Unknown tags are not pre-registered: `perform` allocates fresh signatures
 * on first use, so users (and plugins) can introduce new effects ad hoc.
 */
/**
 * Build the built-in capability method tables.
 *
 * Per spec (marinada.md §Capabilities):
 *   Cap<Network> — get, post, put, delete, ws
 *   Cap<Storage> — get, set, delete, list
 *
 * Plugin-defined caps (e.g. `LocalAgent`) are not registered here — they
 * fall back to `unknown` returns at the call site. Each method declares an
 * effect tag that gets added to the ambient row at the call site.
 */
function makeBuiltinCapMethods(): Map<string, Map<string, CapMethodSig>> {
  const stringArr: MType = { kind: "array", elem: STRING };

  const network = new Map<string, CapMethodSig>();
  // get(url) -> string  ! Network
  network.set("get", { params: [STRING], ret: STRING, effect: "Network" });
  // post(url, body) -> string  ! Network
  network.set("post", { params: [STRING, STRING], ret: STRING, effect: "Network" });
  // put(url, body) -> string  ! Network
  network.set("put", { params: [STRING, STRING], ret: STRING, effect: "Network" });
  // delete(url) -> string  ! Network
  network.set("delete", { params: [STRING], ret: STRING, effect: "Network" });
  // ws(url) -> unknown  ! Network — websocket handle is opaque
  network.set("ws", { params: [STRING], ret: UNKNOWN, effect: "Network" });

  const storage = new Map<string, CapMethodSig>();
  // get(key) -> string | null — modelled as `unknown` until DU narrowing
  storage.set("get", { params: [STRING], ret: UNKNOWN, effect: "Storage" });
  // set(key, value) -> null
  storage.set("set", { params: [STRING, STRING], ret: NULL_T, effect: "Storage" });
  // delete(key) -> null
  storage.set("delete", { params: [STRING], ret: NULL_T, effect: "Storage" });
  // list(prefix) -> array<string>
  storage.set("list", { params: [STRING], ret: stringArr, effect: "Storage" });

  const out = new Map<string, Map<string, CapMethodSig>>();
  out.set("Network", network);
  out.set("Storage", storage);
  return out;
}

function makeStdEffectSigs(state: State): Map<string, EffectSig> {
  const sigs = new Map<string, EffectSig>();
  for (const tag of ["Error", "Async", "Yield"]) {
    sigs.set(tag, { payload: state.freshVar(), resume: state.freshVar() });
  }
  return sigs;
}

/**
 * Convert module type definitions into TypeDefInfo entries. For Phase 3 we do
 * not yet have a syntax for declaring type parameters — DUs declared in a
 * module are monomorphic. Field type strings resolve via parseTypeAnnotation;
 * unknown names become `unknown`.
 */
function registerModuleTypeDefs(
  defs: TypeDef[],
  typeDefs: Map<string, TypeDefInfo>,
  ctors: Map<string, string>,
): void {
  for (const def of defs) {
    const variants = new Map<string, MType[]>();
    for (const variant of def.variants) {
      const fields: MType[] = (variant.fields ?? []).map(([, t]) => parseTypeAnnotation(t));
      variants.set(variant.tag, fields);
      ctors.set(variant.tag, def.name);
    }
    typeDefs.set(def.name, { params: [], variants });
  }
}

// ---------------------------------------------------------------------------
// TypeInfo — per-subexpression type index
// ---------------------------------------------------------------------------

/** Query interface for per-node type information after inference. */
export type TypeInfo = {
  /** Return the inferred type at the given path, or null if the path is unknown. */
  typeOf(path: number[]): MType | null;
  /** Return the effect row type at the given path, or null if not applicable. */
  effectsOf(path: number[]): MType | null;
  /**
   * Returns true if this expression, when called (for fn types) or evaluated
   * (for other types), will produce no observable effects — i.e. its effect
   * row has no concrete fields. The row's tail may be open (a free var), which
   * is the normal HM artifact for code that never invoked a concrete effect.
   */
  isPure(path: number[]): boolean;
};

/**
 * Run inference on `expr` and build a TypeInfo index keyed by path.
 * `typeOf([])` returns the type of the root expression.
 * `typeOf([1])` returns the type of the first argument.
 * etc.
 */
export function buildTypeInfo(expr: Expr, env?: TypeEnv): TypeInfo {
  const state = new State();
  const { typeDefs, ctors } = makeStdTypeDefs();
  const effectSigs = makeStdEffectSigs(state);
  // typeIndex maps JSON-serialized path → {type, effectsRowId}
  // effectsRowId is the MType reference of currentEffects at the time infer() was called.
  const rawIndex = new Map<string, { type: MType; effectsRowId: MType }>();

  const useEnv = env ?? EMPTY_TYPE_ENV;
  const currentEffects = freshEffectsRow(state);

  const baseCtx: Ctx = {
    errors: [],
    path: [],
    state,
    typeDefs,
    ctors,
    effectSigs,
    capMethods: makeBuiltinCapMethods(),
    currentEffects,
    typeIndex: rawIndex,
  };

  // Run inference — this populates rawIndex with per-path types and effect row refs.
  infer(expr, useEnv, baseCtx);

  function pathKey(path: number[]): string {
    return JSON.stringify(path);
  }

  function hasNoConcreteFields(t: MType): boolean {
    const r = zonk(t, state.subst);
    if (r.kind !== "row") return false;
    return r.fields.size === 0;
  }

  return {
    typeOf(path: number[]): MType | null {
      const entry = rawIndex.get(pathKey(path));
      if (!entry) return null;
      return zonk(entry.type, state.subst);
    },
    effectsOf(path: number[]): MType | null {
      const entry = rawIndex.get(pathKey(path));
      if (!entry) return null;
      return zonk(entry.effectsRowId, state.subst);
    },
    isPure(path: number[]): boolean {
      const entry = rawIndex.get(pathKey(path));
      if (!entry) return false;
      const t = zonk(entry.type, state.subst);
      // For fn types, check the fn's own effect row (effects when called).
      // For other types, check the expression's ambient effect row (effects when evaluated).
      if (t.kind === "fn" && t.effects !== undefined) {
        return hasNoConcreteFields(t.effects);
      }
      return hasNoConcreteFields(entry.effectsRowId);
    },
  };
}

/**
 * Resolves a module import path to a `Module`. Mirrors `ModuleResolver` in
 * `module.ts`; defined locally here to avoid an import cycle between
 * `typecheck.ts` and `module.ts`. `lib:std` is handled automatically via
 * `defaultResolver` — user resolvers do not need to handle it.
 */
type TypecheckModuleResolver = (from: string) => Module | null;

export type TypecheckModuleOptions = {
  resolver?: TypecheckModuleResolver;
};

/**
 * Cache entry for in-flight or completed module typechecks.
 *
 * `in-progress`: this module is currently being typechecked further up the
 * call stack. Importers should use the placeholder type vars allocated for
 * each export name; they are unified with the actual inferred types once
 * the cycle closes (see `typecheckModuleInternal`).
 *
 * `done`: the module has been fully typechecked.
 */
type TypecheckCacheEntry =
  | { status: "in-progress"; placeholders: Map<string, MType>; exportNames: string[] }
  | { status: "done"; result: TypecheckResult };

/**
 * Compute the set of names a module declares as exports for cycle handling.
 * If `module.exports` is present, use it. Otherwise, conservatively peel
 * top-level let/letrec layers from `module.main` to discover binding names.
 */
function discoverExportNames(module: Module): string[] {
  if (module.exports !== undefined) return [...module.exports];
  const out: string[] = [];
  let cur: Expr = module.main;
  while (
    Array.isArray(cur) &&
    cur.length === 3 &&
    (cur[0] === "let" || cur[0] === "letrec") &&
    Array.isArray(cur[1])
  ) {
    for (const b of cur[1] as Expr[]) {
      if (Array.isArray(b) && b.length === 2 && typeof b[0] === "string") out.push(b[0]);
    }
    cur = cur[2] as Expr;
  }
  return out;
}

/**
 * Internal recursive entry that takes an explicit cache so diamond imports
 * resolve once. Public `typecheckModule` is a thin wrapper.
 *
 * `state` is shared across all modules in one typechecking session — the
 * substitution and fresh-var counter must be unified, otherwise placeholder
 * vars allocated for in-progress (cycle-target) modules would not be
 * unifiable with types inferred later when the cycle closes.
 */
function typecheckModuleInternal(
  module: Module,
  resolve: (path: string) => Module | null,
  cache: Map<string, TypecheckCacheEntry>,
  state: State,
): TypecheckResult {
  const { typeDefs, ctors } = makeStdTypeDefs();
  registerModuleTypeDefs(module.types ?? [], typeDefs, ctors);
  const effectSigs = makeStdEffectSigs(state);
  const ctx: Ctx = {
    errors: [],
    path: [],
    state,
    typeDefs,
    ctors,
    effectSigs,
    capMethods: makeBuiltinCapMethods(),
    currentEffects: freshEffectsRow(state),
  };

  // Build the import env by resolving each import via the composed resolver.
  // When a resolver is supplied we recursively typecheck the resolved module
  // and inject the requested names' types.
  let moduleEnv = EMPTY_TYPE_ENV;
  for (const imp of module.imports ?? []) {
    const cached = cache.get(imp.from);
    let importExports: Map<string, MType>;
    let importedExportNames: Set<string>;
    if (cached === undefined) {
      const mod = resolve(imp.from);
      if (mod === null) {
        addError(ctx, "MODULE_NOT_FOUND", `module not found: ${imp.from}`, {
          got: imp.from,
        });
        // Bind requested names as unknown for gradual continuation.
        const fallback: Record<string, MType> = {};
        for (const name of imp.import) fallback[name] = UNKNOWN;
        moduleEnv = moduleEnv.extend(fallback);
        continue;
      }
      // Open an in-progress slot before recursing. Pre-allocate placeholder
      // type vars for each declared export — if the module recurses back
      // into us (a cycle), importers will read these placeholders. Once we
      // finish, we unify each placeholder with the actually inferred type.
      const exportNames = discoverExportNames(mod);
      const placeholders = new Map<string, MType>();
      for (const name of exportNames) placeholders.set(name, state.freshVar());
      cache.set(imp.from, { status: "in-progress", placeholders, exportNames });

      const resolved = typecheckModuleInternal(mod, resolve, cache, state);
      cache.set(imp.from, { status: "done", result: resolved });

      // Close the cycle: unify each placeholder against the actually
      // inferred type for that export. If the cycle expected a different
      // type than was produced, this emits a TYPE_MISMATCH error here.
      if (resolved.ok) {
        const resolvedExports = resolved.exports ?? new Map<string, MType>();
        for (const [name, placeholder] of placeholders) {
          const actual = resolvedExports.get(name);
          if (actual === undefined) continue; // missing-export error reported inside the recursive call
          // Instantiate any polymorphic exported type so its quantified
          // vars are fresh — the placeholder may already be bound to a
          // monomorphic shape from prior use in the cycle.
          const u = unify(placeholder, instantiate(actual, state), state.subst, state);
          if (!u.ok) {
            addError(
              ctx,
              "TYPE_MISMATCH",
              `cycle through ${imp.from}: type mismatch for "${name}": ` + u.reason,
              { got: name },
            );
          }
        }
      }

      // Re-register types so constructors are visible.
      registerModuleTypeDefs(mod.types ?? [], typeDefs, ctors);

      if (!resolved.ok) {
        addError(ctx, "MODULE_IMPORT_ERROR", `module ${imp.from} failed to typecheck`, {
          got: imp.from,
        });
        const fallback: Record<string, MType> = {};
        for (const name of imp.import) fallback[name] = UNKNOWN;
        moduleEnv = moduleEnv.extend(fallback);
        continue;
      }
      importExports = resolved.exports ?? new Map<string, MType>();
      importedExportNames = new Set(exportNames);
    } else if (cached.status === "in-progress") {
      // Cycle: bind imported names to their placeholder type vars. They will
      // be unified with the actual inferred types once the cycle target
      // finishes typechecking (see post-pass below).
      importExports = cached.placeholders;
      importedExportNames = new Set(cached.exportNames);
      // Re-register the module's types so constructors are visible. We can
      // call resolve again (host caches cheaply); this only affects DU
      // constructor visibility, not cycle handling.
      const mod = resolve(imp.from);
      if (mod !== null) registerModuleTypeDefs(mod.types ?? [], typeDefs, ctors);
    } else {
      // Cached done.
      const mod = resolve(imp.from);
      if (mod !== null) registerModuleTypeDefs(mod.types ?? [], typeDefs, ctors);
      if (!cached.result.ok) {
        addError(ctx, "MODULE_IMPORT_ERROR", `module ${imp.from} failed to typecheck`, {
          got: imp.from,
        });
        const fallback: Record<string, MType> = {};
        for (const name of imp.import) fallback[name] = UNKNOWN;
        moduleEnv = moduleEnv.extend(fallback);
        continue;
      }
      importExports = cached.result.exports ?? new Map<string, MType>();
      importedExportNames = new Set(importExports.keys());
    }

    const importBindings: Record<string, MType> = {};
    for (const name of imp.import) {
      const t = importExports.get(name);
      if (t === undefined) {
        if (importedExportNames.has(name)) {
          // Should not happen — placeholders are pre-populated for declared
          // exports — but be defensive.
          importBindings[name] = state.freshVar();
        } else {
          addError(ctx, "UNDEFINED_EXPORT", `module ${imp.from} does not export "${name}"`, {
            got: name,
          });
          importBindings[name] = UNKNOWN;
        }
      } else {
        importBindings[name] = t;
      }
    }
    moduleEnv = moduleEnv.extend(importBindings);
  }

  // Walk module.main peeling let/letrec layers so we can record exports.
  // The semantics of each layer are equivalent to what `infer` does for
  // "let"/"letrec", so behavior on the inner body remains identical to
  // calling infer(module.main, moduleEnv, ctx) directly.
  const exportSet = new Set(module.exports ?? []);
  const exports = new Map<string, MType>();

  let cur: Expr = module.main;
  let curEnv: TypeEnv = moduleEnv;
  let curPath: number[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!Array.isArray(cur) || cur.length !== 3) break;
    const head = cur[0];
    if (head !== "let" && head !== "letrec") break;
    const bindings = cur[1];
    const body = cur[2] as Expr;
    if (!Array.isArray(bindings)) break;

    // Validate binding shapes; if any binding is malformed, fall back to
    // calling infer on the whole `cur` to surface the standard error.
    let malformed = false;
    for (const binding of bindings) {
      if (!Array.isArray(binding) || binding.length !== 2) {
        malformed = true;
        break;
      }
      if (typeof binding[0] !== "string") {
        malformed = true;
        break;
      }
    }
    if (malformed) break;

    if (head === "let") {
      let stepEnv = curEnv;
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i] as Expr[];
        const name = binding[0] as string;
        // Mirror infer's path layout: ["let", BINDINGS=1, BODY=2], inside
        // bindings each is at index i, and the RHS lives at index 1.
        const sub: Ctx = { ...ctx, path: [...curPath, 1, i, 1] };
        const valT = infer(binding[1] as Expr, stepEnv, sub);
        ctx.errors = sub.errors;
        ctx.currentEffects = sub.currentEffects;
        const generalized = generalize(valT, stepEnv, state.subst);
        stepEnv = stepEnv.extend({ [name]: generalized });
        if (exportSet.has(name)) exports.set(name, zonk(generalized, state.subst));
      }
      curEnv = stepEnv;
    } else {
      // letrec
      const placeholders: Record<string, MType> = {};
      const names: string[] = [];
      const vars: MType[] = [];
      for (const binding of bindings) {
        const name = (binding as Expr[])[0] as string;
        const v = state.freshVar();
        placeholders[name] = v;
        names.push(name);
        vars.push(v);
      }
      const recEnv = curEnv.extend(placeholders);
      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i] as Expr[];
        const name = names[i] as string;
        const sub: Ctx = { ...ctx, path: [...curPath, 1, i, 1] };
        const bodyT = infer(binding[1] as Expr, recEnv, sub);
        ctx.errors = sub.errors;
        ctx.currentEffects = sub.currentEffects;
        const subUnify: Ctx = { ...ctx, path: [...curPath, 1, i, 1] };
        unifyOrError(subUnify, vars[i] as MType, bodyT, "letrec binding " + name);
        ctx.errors = subUnify.errors;
      }
      const finalEnv = curEnv.extend(
        Object.fromEntries(
          names.map((n, i) => [n, generalize(vars[i] as MType, curEnv, state.subst)] as const),
        ),
      );
      for (let i = 0; i < names.length; i++) {
        const n = names[i] as string;
        if (exportSet.has(n)) {
          const t = finalEnv.lookup(n);
          if (t !== undefined) exports.set(n, zonk(t, state.subst));
        }
      }
      curEnv = finalEnv;
    }
    curPath = [...curPath, 2];
    cur = body;
  }

  const innerCtx: Ctx = { ...ctx, path: curPath };
  const innerT = infer(cur, curEnv, innerCtx);
  ctx.errors = innerCtx.errors;
  ctx.currentEffects = innerCtx.currentEffects;
  const t = innerT;

  // Phase 2: emit UNDEFINED_EXPORT at typecheck time for any name listed in
  // `module.exports` that wasn't bound by a top-level let/letrec layer in
  // `main`. This catches the case where the export is defined deep inside
  // (e.g. inside an inner let body) and so was never reachable via peeling.
  if (module.exports !== undefined) {
    for (const name of module.exports) {
      if (!exports.has(name)) {
        const t2 = curEnv.lookup(name);
        if (t2 !== undefined) {
          // It's bound somewhere in the env (e.g. came from an import). We
          // still consider this a binding for completeness — record its
          // type in exports rather than erroring.
          exports.set(name, zonk(t2, state.subst));
        } else {
          addError(ctx, "UNDEFINED_EXPORT", `module exports "${name}" but it is never bound`, {
            got: name,
          });
        }
      }
    }
  }

  // Check that the module's top-level expression is pure (no unhandled effects).
  // We only report concrete unhandled tags — a fully-unknown effect row (a
  // free var, no tags) is a gradual escape and must not trigger the error.
  // A row with concrete fields is always a real unhandled effect, regardless
  // of whether the row's tail is closed ("empty") or a fresh free var (the
  // normal artifact of addEffectToRow at module scope).
  const effectsRow = zonk(ctx.currentEffects, state.subst);
  if (effectsRow.kind === "row" && effectsRow.fields.size > 0) {
    const tags = [...effectsRow.fields.keys()].sort();
    addError(ctx, "UNHANDLED_EFFECTS", "unhandled effects at module scope: " + tags.join(", "), {
      got: tags.join(", "),
    });
  }
  if (ctx.errors.length === 0) {
    const linCtx: LinCtx = {
      errors: ctx.errors,
      path: [],
      state,
      ctors,
      typeDefs,
      effectSigs,
      capMethods: ctx.capMethods,
    };
    runLinearityPass(module.main, moduleEnv, linCtx);
  }
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  if (exports.size === 0) {
    return { ok: true, type: zonk(t, state.subst) };
  }
  return { ok: true, type: zonk(t, state.subst), exports };
}

export function typecheckModule(module: Module, opts?: TypecheckModuleOptions): TypecheckResult {
  // User resolver takes priority; defaultResolver (lib:std) is the fallback.
  const resolve = (path: string): Module | null =>
    opts?.resolver?.(path) ?? libStdResolver(path) ?? null;
  return typecheckModuleInternal(module, resolve, new Map(), new State());
}

/**
 * Like `typecheckModule` but without `defaultResolver` composed in. If
 * `opts.resolver` returns `null` for a path, `MODULE_NOT_FOUND` is emitted.
 * `lib:std` is NOT available unless the caller provides it via `opts.resolver`.
 * Use this variant when you want full control over which modules are loaded
 * (e.g. for tree-shaking or custom lib: schemes).
 */
export function typecheckModuleRaw(module: Module, opts?: TypecheckModuleOptions): TypecheckResult {
  const resolve = (path: string): Module | null => opts?.resolver?.(path) ?? null;
  return typecheckModuleInternal(module, resolve, new Map(), new State());
}
