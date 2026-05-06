import type { Expr } from "./types.ts";
import type { TypeInfo } from "./typecheck.ts";

/**
 * A rewrite rule is a tree-automaton transition: given an expression rooted at
 * `headOp`, optionally bind metavariables via `match`, optionally guard via
 * `where`, and produce a new expression via `rewrite`.
 *
 * `reducing: true` marks rules that strictly reduce node count (or some other
 * well-founded measure) — the optimizer can re-fire them at the same position
 * without termination concerns. `reducing: false` rules are guarded against
 * firing twice on the same (node, rule) pair.
 */
export type RewriteRule = {
  name: string;
  /** The op at the rule's root — used for indexing into the rule table. */
  headOp: string;
  match(expr: Expr): Record<string, Expr> | null;
  where?(bindings: Record<string, Expr>, typeInfo?: TypeInfo): boolean;
  rewrite(bindings: Record<string, Expr>): Expr;
  reducing: boolean;
};

// --- Helpers shared by rules ---

function isLit(e: Expr): boolean {
  return Array.isArray(e) && e.length === 2 && e[0] === "__lit";
}

function lit(v: unknown): Expr {
  return ["__lit", v as Expr];
}

/** Lift any constant-shaped expression to its runtime JS value, if possible.
 * Returns { ok: true, value } or { ok: false }. Distinct from `isLit` because
 * the AST atoms `null`, booleans, and numbers are also constants. */
type Const = { ok: true; value: unknown } | { ok: false };

function asConst(e: Expr): Const {
  if (e === null) return { ok: true, value: null };
  if (typeof e === "boolean") return { ok: true, value: e };
  if (typeof e === "number") {
    if (Number.isInteger(e) && !Object.is(e, -0)) {
      return { ok: true, value: BigInt(e) };
    }
    return { ok: true, value: e };
  }
  if (Array.isArray(e) && e.length === 2 && e[0] === "__lit") {
    return { ok: true, value: e[1] };
  }
  return { ok: false };
}

/** True if both args reduce to constant values; returns the JS values. */
function bothConst(a: Expr, b: Expr): { ok: true; a: unknown; b: unknown } | { ok: false } {
  const ca = asConst(a);
  if (!ca.ok) return { ok: false };
  const cb = asConst(b);
  if (!cb.ok) return { ok: false };
  return { ok: true, a: ca.value, b: cb.value };
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

/** Deep equality matching the runtime's _eq semantics. */
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEq(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    return ak.length === bk.length && ak.every((k) => deepEq(ao[k], bo[k]));
  }
  return false;
}

// --- Free variable analysis ---

/** Names bound by a `let`/`letrec`/`fn`/`match`-style construct. */
function paramNames(params: Expr): string[] {
  if (!Array.isArray(params)) return [];
  const out: string[] = [];
  for (const p of params) {
    if (typeof p === "string") out.push(p);
    else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") out.push(p[0]);
  }
  return out;
}

/** Whether `name` appears free (i.e. as a variable reference) in `expr`. */
function freeIn(name: string, expr: Expr): boolean {
  if (typeof expr === "string") return expr === name;
  if (!Array.isArray(expr) || expr.length === 0) return false;
  const op = expr[0];
  if (typeof op !== "string") return expr.some((e) => freeIn(name, e as Expr));

  switch (op) {
    case "__lit":
      return false;
    case "fn":
    case "fn-once": {
      const ps = paramNames(expr[1] as Expr);
      if (ps.includes(name)) return false;
      return freeIn(name, expr[2] as Expr);
    }
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return false;
      // Sequentially: each binding's value sees prior bindings, body sees all.
      let shadowed = false;
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) continue;
        if (!shadowed && freeIn(name, b[1] as Expr)) return true;
        if (b[0] === name) shadowed = true;
      }
      if (shadowed) return false;
      return freeIn(name, expr[2] as Expr);
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return false;
      const names = bindings
        .map((b) => (Array.isArray(b) ? b[0] : null))
        .filter((n): n is string => typeof n === "string");
      if (names.includes(name)) return false;
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) continue;
        if (freeIn(name, b[1] as Expr)) return true;
      }
      return freeIn(name, expr[2] as Expr);
    }
    case "match": {
      // ["match", scrut, [pattern, body], ...]
      if (freeIn(name, expr[1] as Expr)) return true;
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const pattern = clause[0];
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        if (!bound.includes(name) && freeIn(name, body)) return true;
      }
      return false;
    }
    case "handle": {
      if (freeIn(name, expr[1] as Expr)) return true;
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const pattern = clause[0];
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        if (!bound.includes(name) && freeIn(name, body)) return true;
      }
      return false;
    }
    case "__loop": {
      // ["__loop", params, initArgs, body]
      const ps = paramNames(expr[1] as Expr);
      const initArgs = expr[2];
      if (Array.isArray(initArgs)) {
        for (const a of initArgs) if (freeIn(name, a as Expr)) return true;
      }
      if (ps.includes(name)) return false;
      return freeIn(name, expr[3] as Expr);
    }
    default:
      // Default: traverse all sub-expressions. Op string itself isn't a var ref.
      for (let i = 1; i < expr.length; i++) {
        if (freeIn(name, expr[i] as Expr)) return true;
      }
      return false;
  }
}

/** Conservatively decide whether evaluating `expr` can have observable effects.
 * Used to decide if a dead binding's value can be safely dropped. */
function hasEffects(expr: Expr): boolean {
  if (expr === null || typeof expr === "boolean" || typeof expr === "number") return false;
  if (typeof expr === "string") return false; // bare var ref — no effect
  if (!Array.isArray(expr) || expr.length === 0) return false;
  const op = expr[0];
  if (typeof op !== "string") return true;
  switch (op) {
    case "perform":
    case "handle":
    case "call":
    case "as": // throws on type mismatch — treat as effect
      return true;
    case "/":
    case "%":
      // Integer division/modulo by zero throws; conservatively treat as effect
      // unless we can prove the divisor is non-zero.
      if (expr.length === 3) {
        const c = asConst(expr[2] as Expr);
        if (c.ok && typeof c.value === "bigint" && c.value !== 0n) {
          return hasEffects(expr[1] as Expr);
        }
        if (c.ok && typeof c.value === "number" && c.value !== 0) {
          return hasEffects(expr[1] as Expr);
        }
      }
      return true;
    case "__lit":
      return false;
    case "fn":
    case "fn-once":
      return false; // creating a closure has no effect (body is deferred)
    default:
      for (let i = 1; i < expr.length; i++) {
        if (hasEffects(expr[i] as Expr)) return true;
      }
      return false;
  }
}

/** Substitute `name` → `value` inside `expr`. Respects shadowing. */
function substitute(expr: Expr, name: string, value: Expr): Expr {
  if (typeof expr === "string") return expr === name ? value : expr;
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => substitute(e as Expr, name, value)) as Expr;
  }

  switch (op) {
    case "__lit":
      return expr;
    case "fn":
    case "fn-once": {
      const ps = paramNames(expr[1] as Expr);
      if (ps.includes(name)) return expr;
      return [op, expr[1] as Expr, substitute(expr[2] as Expr, name, value)];
    }
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newBindings: Expr[] = [];
      let shadowed = false;
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) {
          newBindings.push(b as Expr);
          continue;
        }
        const bName = b[0] as string;
        const bVal = b[1] as Expr;
        const newVal = shadowed ? bVal : substitute(bVal, name, value);
        newBindings.push([bName, newVal] as Expr);
        if (bName === name) shadowed = true;
      }
      const newBody = shadowed ? (expr[2] as Expr) : substitute(expr[2] as Expr, name, value);
      return ["let", newBindings as Expr, newBody];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const names = bindings
        .map((b) => (Array.isArray(b) ? b[0] : null))
        .filter((n): n is string => typeof n === "string");
      if (names.includes(name)) return expr;
      const newBindings = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, substitute(b[1] as Expr, name, value)] as Expr;
      });
      return ["letrec", newBindings as Expr, substitute(expr[2] as Expr, name, value)];
    }
    case "match": {
      const newArr: Expr[] = [op, substitute(expr[1] as Expr, name, value)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          newArr.push(clause as Expr);
          continue;
        }
        const pattern = clause[0] as Expr;
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        const newBody = bound.includes(name) ? body : substitute(body, name, value);
        newArr.push([pattern, newBody] as Expr);
      }
      return newArr;
    }
    case "handle": {
      const newArr: Expr[] = [op, substitute(expr[1] as Expr, name, value)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          newArr.push(clause as Expr);
          continue;
        }
        const pattern = clause[0] as Expr;
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        const newBody = bound.includes(name) ? body : substitute(body, name, value);
        newArr.push([pattern, newBody] as Expr);
      }
      return newArr;
    }
    case "__loop": {
      const ps = paramNames(expr[1] as Expr);
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => substitute(a as Expr, name, value)) as Expr)
        : (initArgs as Expr);
      const body = expr[3] as Expr;
      const newBody = ps.includes(name) ? body : substitute(body, name, value);
      return [op, expr[1] as Expr, newInit, newBody];
    }
    default:
      return expr.map((e) => substitute(e as Expr, name, value)) as Expr;
  }
}

// --- Constant folding rules ---

/** Helper to build an arithmetic-fold rule for a binary numeric op. */
function arithRule(
  op: string,
  fn: (a: bigint, b: bigint) => bigint | null,
  ffn: (a: number, b: number) => number,
): RewriteRule {
  return {
    name: `fold-${op}`,
    headOp: op,
    reducing: true,
    match(e) {
      if (!Array.isArray(e) || e.length !== 3 || e[0] !== op) return null;
      return { a: e[1] as Expr, b: e[2] as Expr };
    },
    where(b) {
      const c = bothConst(b.a as Expr, b.b as Expr);
      if (!c.ok) return false;
      const va = c.a;
      const vb = c.b;
      if (typeof va === "bigint" && typeof vb === "bigint") {
        const r = fn(va, vb);
        return r !== null;
      }
      if (
        (typeof va === "bigint" || typeof va === "number") &&
        (typeof vb === "bigint" || typeof vb === "number")
      ) {
        const av = typeof va === "bigint" ? Number(va) : va;
        const bv = typeof vb === "bigint" ? Number(vb) : vb;
        const r = ffn(av, bv);
        return Number.isFinite(r);
      }
      return false;
    },
    rewrite(b) {
      const c = bothConst(b.a as Expr, b.b as Expr) as {
        ok: true;
        a: unknown;
        b: unknown;
      };
      const va = c.a;
      const vb = c.b;
      if (typeof va === "bigint" && typeof vb === "bigint") {
        const r = fn(va, vb);
        return lit(r);
      }
      const av = typeof va === "bigint" ? Number(va) : (va as number);
      const bv = typeof vb === "bigint" ? Number(vb) : (vb as number);
      return lit(ffn(av, bv));
    },
  };
}

function cmpRule(op: string, fn: (a: number, b: number) => boolean): RewriteRule {
  return {
    name: `fold-${op}`,
    headOp: op,
    reducing: true,
    match(e) {
      if (!Array.isArray(e) || e.length !== 3 || e[0] !== op) return null;
      return { a: e[1] as Expr, b: e[2] as Expr };
    },
    where(b) {
      const c = bothConst(b.a as Expr, b.b as Expr);
      if (!c.ok) return false;
      return (
        (typeof c.a === "bigint" || typeof c.a === "number") &&
        (typeof c.b === "bigint" || typeof c.b === "number")
      );
    },
    rewrite(b) {
      const c = bothConst(b.a as Expr, b.b as Expr) as {
        ok: true;
        a: unknown;
        b: unknown;
      };
      const av = typeof c.a === "bigint" ? Number(c.a) : (c.a as number);
      const bv = typeof c.b === "bigint" ? Number(c.b) : (c.b as number);
      return lit(fn(av, bv));
    },
  };
}

const FOLD_ADD = arithRule(
  "+",
  (a, b) => a + b,
  (a, b) => a + b,
);
const FOLD_SUB = arithRule(
  "-",
  (a, b) => a - b,
  (a, b) => a - b,
);
const FOLD_MUL = arithRule(
  "*",
  (a, b) => a * b,
  (a, b) => a * b,
);
const FOLD_DIV: RewriteRule = {
  name: "fold-/",
  headOp: "/",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "/") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = bothConst(b.a as Expr, b.b as Expr);
    if (!c.ok) return false;
    if (typeof c.a === "bigint" && typeof c.b === "bigint") {
      return c.b !== 0n; // do not fold integer division by zero
    }
    if (
      (typeof c.a === "bigint" || typeof c.a === "number") &&
      (typeof c.b === "bigint" || typeof c.b === "number")
    ) {
      const av = typeof c.a === "bigint" ? Number(c.a) : c.a;
      const bv = typeof c.b === "bigint" ? Number(c.b) : c.b;
      return isFiniteNumber(av / bv);
    }
    return false;
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as {
      ok: true;
      a: unknown;
      b: unknown;
    };
    if (typeof c.a === "bigint" && typeof c.b === "bigint") {
      return lit(c.a / c.b);
    }
    const av = typeof c.a === "bigint" ? Number(c.a) : (c.a as number);
    const bv = typeof c.b === "bigint" ? Number(c.b) : (c.b as number);
    return lit(av / bv);
  },
};

const FOLD_MOD: RewriteRule = {
  name: "fold-%",
  headOp: "%",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "%") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = bothConst(b.a as Expr, b.b as Expr);
    if (!c.ok) return false;
    if (typeof c.a === "bigint" && typeof c.b === "bigint") {
      return c.b !== 0n;
    }
    if (
      (typeof c.a === "bigint" || typeof c.a === "number") &&
      (typeof c.b === "bigint" || typeof c.b === "number")
    ) {
      const av = typeof c.a === "bigint" ? Number(c.a) : c.a;
      const bv = typeof c.b === "bigint" ? Number(c.b) : c.b;
      return isFiniteNumber(av % bv);
    }
    return false;
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as {
      ok: true;
      a: unknown;
      b: unknown;
    };
    if (typeof c.a === "bigint" && typeof c.b === "bigint") {
      return lit(c.a % c.b);
    }
    const av = typeof c.a === "bigint" ? Number(c.a) : (c.a as number);
    const bv = typeof c.b === "bigint" ? Number(c.b) : (c.b as number);
    return lit(av % bv);
  },
};

const FOLD_EQ: RewriteRule = {
  name: "fold-==",
  headOp: "==",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "==") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    return bothConst(b.a as Expr, b.b as Expr).ok;
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as {
      ok: true;
      a: unknown;
      b: unknown;
    };
    return lit(deepEq(c.a, c.b));
  },
};

const FOLD_NEQ: RewriteRule = {
  name: "fold-!=",
  headOp: "!=",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "!=") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    return bothConst(b.a as Expr, b.b as Expr).ok;
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as {
      ok: true;
      a: unknown;
      b: unknown;
    };
    return lit(!deepEq(c.a, c.b));
  },
};

const FOLD_LT = cmpRule("<", (a, b) => a < b);
const FOLD_LE = cmpRule("<=", (a, b) => a <= b);
const FOLD_GT = cmpRule(">", (a, b) => a > b);
const FOLD_GE = cmpRule(">=", (a, b) => a >= b);

const FOLD_NOT: RewriteRule = {
  name: "fold-not",
  headOp: "not",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 2 || e[0] !== "not") return null;
    return { a: e[1] as Expr };
  },
  where(b) {
    const c = asConst(b.a as Expr);
    return c.ok && typeof c.value === "boolean";
  },
  rewrite(b) {
    const c = asConst(b.a as Expr) as { ok: true; value: unknown };
    return lit(!(c.value as boolean));
  },
};

const FOLD_AND: RewriteRule = {
  name: "fold-and",
  headOp: "and",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "and") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = asConst(b.a as Expr);
    return c.ok && typeof c.value === "boolean";
  },
  rewrite(b) {
    const c = asConst(b.a as Expr) as { ok: true; value: unknown };
    if (c.value === false) return lit(false);
    // c.value === true — short-circuit to right.
    return b.b as Expr;
  },
};

const FOLD_OR: RewriteRule = {
  name: "fold-or",
  headOp: "or",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "or") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = asConst(b.a as Expr);
    return c.ok && typeof c.value === "boolean";
  },
  rewrite(b) {
    const c = asConst(b.a as Expr) as { ok: true; value: unknown };
    if (c.value === true) return lit(true);
    return b.b as Expr;
  },
};

const FOLD_IF: RewriteRule = {
  name: "fold-if",
  headOp: "if",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 4 || e[0] !== "if") return null;
    return { c: e[1] as Expr, t: e[2] as Expr, f: e[3] as Expr };
  },
  where(b) {
    const c = asConst(b.c as Expr);
    return c.ok && typeof c.value === "boolean";
  },
  rewrite(b) {
    const c = asConst(b.c as Expr) as { ok: true; value: unknown };
    return c.value === true ? (b.t as Expr) : (b.f as Expr);
  },
};

const FOLD_COND: RewriteRule = {
  name: "fold-cond",
  headOp: "cond",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e[0] !== "cond" || e.length < 2) return null;
    // Find the first clause whose test is a known constant true OR the "else" clause,
    // skipping any leading clauses whose test is constant false.
    for (let i = 1; i < e.length; i++) {
      const clause = e[i];
      if (!Array.isArray(clause) || clause.length !== 2) return null;
      const test = clause[0];
      if (test === "else") {
        return { body: clause[1] as Expr };
      }
      const c = asConst(test as Expr);
      if (!c.ok || typeof c.value !== "boolean") return null;
      if (c.value === true) {
        return { body: clause[1] as Expr };
      }
      // false — skip and continue
    }
    return null;
  },
  rewrite(b) {
    return b.body as Expr;
  },
};

// --- String folding ---

function strRule1(op: string, fn: (s: string) => unknown): RewriteRule {
  return {
    name: `fold-${op}`,
    headOp: op,
    reducing: true,
    match(e) {
      if (!Array.isArray(e) || e.length !== 2 || e[0] !== op) return null;
      return { a: e[1] as Expr };
    },
    where(b) {
      const c = asConst(b.a as Expr);
      return c.ok && typeof c.value === "string";
    },
    rewrite(b) {
      const c = asConst(b.a as Expr) as { ok: true; value: unknown };
      return lit(fn(c.value as string));
    },
  };
}

const FOLD_STR_LEN = strRule1("str-len", (s) => BigInt(s.length));

const FOLD_STR_CONCAT: RewriteRule = {
  name: "fold-str-concat",
  headOp: "str-concat",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "str-concat") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = bothConst(b.a as Expr, b.b as Expr);
    return c.ok && typeof c.a === "string" && typeof c.b === "string";
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as {
      ok: true;
      a: unknown;
      b: unknown;
    };
    return lit((c.a as string) + (c.b as string));
  },
};

const FOLD_STR_SLICE: RewriteRule = {
  name: "fold-str-slice",
  headOp: "str-slice",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 4 || e[0] !== "str-slice") return null;
    return { s: e[1] as Expr, a: e[2] as Expr, b: e[3] as Expr };
  },
  where(b) {
    const cs = asConst(b.s as Expr);
    const ca = asConst(b.a as Expr);
    const cb = asConst(b.b as Expr);
    return (
      cs.ok &&
      ca.ok &&
      cb.ok &&
      typeof cs.value === "string" &&
      (typeof ca.value === "bigint" || typeof ca.value === "number") &&
      (typeof cb.value === "bigint" || typeof cb.value === "number")
    );
  },
  rewrite(b) {
    const cs = asConst(b.s as Expr) as { ok: true; value: unknown };
    const ca = asConst(b.a as Expr) as { ok: true; value: unknown };
    const cb = asConst(b.b as Expr) as { ok: true; value: unknown };
    const start = typeof ca.value === "bigint" ? Number(ca.value) : (ca.value as number);
    const end = typeof cb.value === "bigint" ? Number(cb.value) : (cb.value as number);
    return lit((cs.value as string).slice(start, end));
  },
};

// --- Array / record / get ---

const FOLD_ARRAY: RewriteRule = {
  name: "fold-array",
  headOp: "array",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e[0] !== "array") return null;
    return { e: e as Expr };
  },
  where(b) {
    const e = b.e as Expr[];
    for (let i = 1; i < e.length; i++) {
      if (!asConst(e[i] as Expr).ok) return false;
    }
    return true;
  },
  rewrite(b) {
    const e = b.e as Expr[];
    const vals: unknown[] = [];
    for (let i = 1; i < e.length; i++) {
      vals.push((asConst(e[i] as Expr) as { ok: true; value: unknown }).value);
    }
    return lit(vals);
  },
};

const FOLD_GET: RewriteRule = {
  name: "fold-get",
  headOp: "get",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "get") return null;
    return { obj: e[1] as Expr, key: e[2] as Expr };
  },
  where(b) {
    const co = asConst(b.obj as Expr);
    const ck = asConst(b.key as Expr);
    if (!co.ok || !ck.ok) return false;
    // Only fold when the constant obj is a plain array or plain record literal.
    return (
      Array.isArray(co.value) ||
      (co.value !== null && typeof co.value === "object" && !Array.isArray(co.value))
    );
  },
  rewrite(b) {
    const co = asConst(b.obj as Expr) as { ok: true; value: unknown };
    const ck = asConst(b.key as Expr) as { ok: true; value: unknown };
    if (Array.isArray(co.value)) {
      const idx = typeof ck.value === "bigint" ? Number(ck.value) : (ck.value as number);
      if (idx < 0 || idx >= co.value.length) return lit(null);
      return lit((co.value[idx] as unknown) ?? null);
    }
    const k = String(ck.value);
    const obj = co.value as Record<string, unknown>;
    const v = obj[k];
    return lit(v === undefined ? null : v);
  },
};

// --- to-string ---

const FOLD_TO_STRING: RewriteRule = {
  name: "fold-to-string",
  headOp: "to-string",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 2 || e[0] !== "to-string") return null;
    return { a: e[1] as Expr };
  },
  where(b) {
    const c = asConst(b.a as Expr);
    if (!c.ok) return false;
    const v = c.value;
    return (
      v === null ||
      typeof v === "boolean" ||
      typeof v === "bigint" ||
      typeof v === "number" ||
      typeof v === "string"
    );
  },
  rewrite(b) {
    const c = asConst(b.a as Expr) as { ok: true; value: unknown };
    const v = c.value;
    if (v === null) return lit("null");
    if (typeof v === "boolean") return lit(v ? "true" : "false");
    if (typeof v === "bigint") return lit(v.toString());
    if (typeof v === "number") return lit(v.toString());
    return lit(v as string);
  },
};

// --- let dead-binding elimination + literal copy propagation ---

const FOLD_LET: RewriteRule = {
  name: "fold-let",
  headOp: "let",
  reducing: false, // dropping a binding is not strictly node-reducing under
  // single-rule retry (a re-fired rule would see no bindings); guarded by
  // termination check.
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "let") return null;
    const bindings = e[1];
    if (!Array.isArray(bindings) || bindings.length === 0) return null;
    return { e: e as Expr };
  },
  where(b) {
    const e = b.e as Expr[];
    const bindings = e[1] as Expr[];
    const body = e[2] as Expr;
    // Eligible if at least one binding can be eliminated or substituted.
    // Walk through bindings in order — once we find one to drop/substitute, fire.
    let restBody = body;
    // Walk in reverse to know "the body of the binding scope" for each binding.
    // Simpler: approximate — fire if the FIRST binding is droppable or literal-substitutable
    // when considered with its scope. We rebuild fully in rewrite.
    void restBody;
    for (let i = 0; i < bindings.length; i++) {
      const bb = bindings[i];
      if (!Array.isArray(bb) || bb.length !== 2) continue;
      const name = bb[0] as string;
      const val = bb[1] as Expr;
      // The "scope" for this binding is bindings[i+1..].vals followed by body.
      // For simplicity, if name not free in any later expr → droppable (if no effects).
      let usedLater = freeIn(name, body);
      for (let j = i + 1; !usedLater && j < bindings.length; j++) {
        const bj = bindings[j];
        if (Array.isArray(bj) && bj.length === 2) {
          if (freeIn(name, bj[1] as Expr)) usedLater = true;
        }
      }
      if (!usedLater && !hasEffects(val)) return true;
      if (isLit(val)) return true;
    }
    return false;
  },
  rewrite(b) {
    const e = b.e as Expr[];
    const bindings = (e[1] as Expr[]).slice();
    let body = e[2] as Expr;

    // Process from the END so that substituting earlier preserves shadowing semantics.
    // We'll build a list of remaining bindings in order.
    const kept: Expr[] = [];
    // Walk forward; for each binding, decide drop / substitute / keep.
    // Substituting requires propagating into later bindings' values AND body.
    for (let i = 0; i < bindings.length; i++) {
      const bb = bindings[i];
      if (!Array.isArray(bb) || bb.length !== 2) {
        kept.push(bb as Expr);
        continue;
      }
      const name = bb[0] as string;
      const val = bb[1] as Expr;

      // Compute "rest scope": later bindings (with current `kept` already fixed) + body.
      let usedLater = freeIn(name, body);
      const laterBindings = bindings.slice(i + 1);
      for (let j = 0; !usedLater && j < laterBindings.length; j++) {
        const bj = laterBindings[j];
        if (Array.isArray(bj) && bj.length === 2) {
          if (freeIn(name, bj[1] as Expr)) usedLater = true;
        }
      }

      if (!usedLater && !hasEffects(val)) {
        // Drop this binding entirely.
        continue;
      }

      if (isLit(val)) {
        // Substitute name → val in later bindings' values and in body.
        for (let j = i + 1; j < bindings.length; j++) {
          const bj = bindings[j];
          if (Array.isArray(bj) && bj.length === 2) {
            const bjName = bj[0] as string;
            // Stop substituting once a later binding shadows this name.
            if (bjName === name) break;
            bindings[j] = [bjName, substitute(bj[1] as Expr, name, val)] as Expr;
          }
        }
        body = substitute(body, name, val);
        // Drop the binding (its uses have been inlined).
        continue;
      }

      kept.push([name, val] as Expr);
    }

    if (kept.length === 0) return body;
    return ["let", kept as Expr, body];
  },
};

// --- Bitwise folding (bigint-only; the runtime ops require integer operands) ---

function bitRule(op: string, fn: (a: bigint, b: bigint) => bigint): RewriteRule {
  return {
    name: `fold-${op}`,
    headOp: op,
    reducing: true,
    match(e) {
      if (!Array.isArray(e) || e.length !== 3 || e[0] !== op) return null;
      return { a: e[1] as Expr, b: e[2] as Expr };
    },
    where(b) {
      const c = bothConst(b.a as Expr, b.b as Expr);
      if (!c.ok) return false;
      const va = typeof c.a === "number" && Number.isInteger(c.a) ? BigInt(c.a) : c.a;
      const vb = typeof c.b === "number" && Number.isInteger(c.b) ? BigInt(c.b) : c.b;
      if (typeof va !== "bigint" || typeof vb !== "bigint") return false;
      // bit-shl / bit-shr: refuse to fold for negative shift counts (runtime would throw).
      if ((op === "bit-shl" || op === "bit-shr") && vb < 0n) return false;
      return true;
    },
    rewrite(b) {
      const c = bothConst(b.a as Expr, b.b as Expr) as { ok: true; a: unknown; b: unknown };
      const va = typeof c.a === "number" ? BigInt(c.a as number) : (c.a as bigint);
      const vb = typeof c.b === "number" ? BigInt(c.b as number) : (c.b as bigint);
      return lit(fn(va, vb));
    },
  };
}

const FOLD_BIT_AND = bitRule("bit-and", (a, b) => a & b);
const FOLD_BIT_OR = bitRule("bit-or", (a, b) => a | b);
const FOLD_BIT_XOR = bitRule("bit-xor", (a, b) => a ^ b);
const FOLD_BIT_SHL = bitRule("bit-shl", (a, b) => a << b);
const FOLD_BIT_SHR = bitRule("bit-shr", (a, b) => a >> b);

const FOLD_BIT_NOT: RewriteRule = {
  name: "fold-bit-not",
  headOp: "bit-not",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 2 || e[0] !== "bit-not") return null;
    return { a: e[1] as Expr };
  },
  where(b) {
    const c = asConst(b.a as Expr);
    if (!c.ok) return false;
    return (
      typeof c.value === "bigint" || (typeof c.value === "number" && Number.isInteger(c.value))
    );
  },
  rewrite(b) {
    const c = asConst(b.a as Expr) as { ok: true; value: unknown };
    const v = typeof c.value === "number" ? BigInt(c.value as number) : (c.value as bigint);
    return lit(~v);
  },
};

// --- Math function folding ---
//
// Per the runtime in jit.ts: floor/ceil/round are no-ops on bigints (return as-is)
// and use Math.* on numbers. abs handles both. min/max accept either.

function mathUnaryRule(
  op: string,
  bigFn: (a: bigint) => bigint,
  numFn: (a: number) => number,
): RewriteRule {
  return {
    name: `fold-${op}`,
    headOp: op,
    reducing: true,
    match(e) {
      if (!Array.isArray(e) || e.length !== 2 || e[0] !== op) return null;
      return { a: e[1] as Expr };
    },
    where(b) {
      const c = asConst(b.a as Expr);
      if (!c.ok) return false;
      if (typeof c.value === "bigint") return true;
      if (typeof c.value === "number") return Number.isFinite(numFn(c.value));
      return false;
    },
    rewrite(b) {
      const c = asConst(b.a as Expr) as { ok: true; value: unknown };
      if (typeof c.value === "bigint") return lit(bigFn(c.value));
      return lit(numFn(c.value as number));
    },
  };
}

const FOLD_FLOOR = mathUnaryRule(
  "floor",
  (a) => a,
  (a) => Math.floor(a),
);
const FOLD_CEIL = mathUnaryRule(
  "ceil",
  (a) => a,
  (a) => Math.ceil(a),
);
const FOLD_ROUND = mathUnaryRule(
  "round",
  (a) => a,
  (a) => Math.round(a),
);
const FOLD_ABS = mathUnaryRule(
  "abs",
  (a) => (a < 0n ? -a : a),
  (a) => Math.abs(a),
);

function mathBinaryRule(
  op: string,
  bigFn: (a: bigint, b: bigint) => bigint,
  numFn: (a: number, b: number) => number,
): RewriteRule {
  return {
    name: `fold-${op}`,
    headOp: op,
    reducing: true,
    match(e) {
      if (!Array.isArray(e) || e.length !== 3 || e[0] !== op) return null;
      return { a: e[1] as Expr, b: e[2] as Expr };
    },
    where(b) {
      const c = bothConst(b.a as Expr, b.b as Expr);
      if (!c.ok) return false;
      if (typeof c.a === "bigint" && typeof c.b === "bigint") return true;
      if (
        (typeof c.a === "bigint" || typeof c.a === "number") &&
        (typeof c.b === "bigint" || typeof c.b === "number")
      ) {
        const av = typeof c.a === "bigint" ? Number(c.a) : c.a;
        const bv = typeof c.b === "bigint" ? Number(c.b) : c.b;
        return Number.isFinite(numFn(av, bv));
      }
      return false;
    },
    rewrite(b) {
      const c = bothConst(b.a as Expr, b.b as Expr) as { ok: true; a: unknown; b: unknown };
      if (typeof c.a === "bigint" && typeof c.b === "bigint") return lit(bigFn(c.a, c.b));
      const av = typeof c.a === "bigint" ? Number(c.a) : (c.a as number);
      const bv = typeof c.b === "bigint" ? Number(c.b) : (c.b as number);
      return lit(numFn(av, bv));
    },
  };
}

const FOLD_MIN = mathBinaryRule(
  "min",
  (a, b) => (a < b ? a : b),
  (a, b) => Math.min(a, b),
);
const FOLD_MAX = mathBinaryRule(
  "max",
  (a, b) => (a > b ? a : b),
  (a, b) => Math.max(a, b),
);

// pow: jit.ts compiles to Math.pow(Number(a), Number(b)) — always returns a number.
const FOLD_POW: RewriteRule = {
  name: "fold-pow",
  headOp: "pow",
  reducing: true,
  match(e) {
    if (!Array.isArray(e) || e.length !== 3 || e[0] !== "pow") return null;
    return { a: e[1] as Expr, b: e[2] as Expr };
  },
  where(b) {
    const c = bothConst(b.a as Expr, b.b as Expr);
    if (!c.ok) return false;
    if (
      (typeof c.a !== "bigint" && typeof c.a !== "number") ||
      (typeof c.b !== "bigint" && typeof c.b !== "number")
    ) {
      return false;
    }
    const av = typeof c.a === "bigint" ? Number(c.a) : c.a;
    const bv = typeof c.b === "bigint" ? Number(c.b) : c.b;
    return Number.isFinite(Math.pow(av, bv));
  },
  rewrite(b) {
    const c = bothConst(b.a as Expr, b.b as Expr) as { ok: true; a: unknown; b: unknown };
    const av = typeof c.a === "bigint" ? Number(c.a) : (c.a as number);
    const bv = typeof c.b === "bigint" ? Number(c.b) : (c.b as number);
    return lit(Math.pow(av, bv));
  },
};

export const CONSTANT_FOLDING_RULES: RewriteRule[] = [
  FOLD_ADD,
  FOLD_SUB,
  FOLD_MUL,
  FOLD_DIV,
  FOLD_MOD,
  FOLD_EQ,
  FOLD_NEQ,
  FOLD_LT,
  FOLD_LE,
  FOLD_GT,
  FOLD_GE,
  FOLD_NOT,
  FOLD_AND,
  FOLD_OR,
  FOLD_IF,
  FOLD_COND,
  FOLD_STR_LEN,
  FOLD_STR_CONCAT,
  FOLD_STR_SLICE,
  FOLD_ARRAY,
  FOLD_GET,
  FOLD_TO_STRING,
  FOLD_LET,
  FOLD_BIT_AND,
  FOLD_BIT_OR,
  FOLD_BIT_XOR,
  FOLD_BIT_SHL,
  FOLD_BIT_SHR,
  FOLD_BIT_NOT,
  FOLD_FLOOR,
  FOLD_CEIL,
  FOLD_ROUND,
  FOLD_ABS,
  FOLD_MIN,
  FOLD_MAX,
  FOLD_POW,
];

// --- Tree-automaton driver ---

/** Index rules by their `headOp` for O(1) dispatch. */
function indexRules(rules: RewriteRule[]): Map<string, RewriteRule[]> {
  const m = new Map<string, RewriteRule[]>();
  for (const r of rules) {
    const arr = m.get(r.headOp);
    if (arr) arr.push(r);
    else m.set(r.headOp, [r]);
  }
  return m;
}

/** Recursively optimize children of `expr` (post-order), then return a new
 * expression with optimized children. Returns the input unchanged when no
 * structure recursion applies. */
function optimizeChildren(
  expr: Expr,
  index: Map<string, RewriteRule[]>,
  fired: WeakMap<object, Set<string>>,
  typeInfo?: TypeInfo,
): Expr {
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => optimizeNode(e as Expr, index, fired, typeInfo)) as Expr;
  }

  switch (op) {
    case "__lit":
      return expr;
    case "fn":
    case "fn-once":
      return [op, expr[1] as Expr, optimizeNode(expr[2] as Expr, index, fired, typeInfo)];
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newBindings = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, optimizeNode(b[1] as Expr, index, fired, typeInfo)] as Expr;
      });
      return ["let", newBindings as Expr, optimizeNode(expr[2] as Expr, index, fired, typeInfo)];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newBindings = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, optimizeNode(b[1] as Expr, index, fired, typeInfo)] as Expr;
      });
      return ["letrec", newBindings as Expr, optimizeNode(expr[2] as Expr, index, fired, typeInfo)];
    }
    case "match": {
      const out: Expr[] = [op, optimizeNode(expr[1] as Expr, index, fired, typeInfo)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        out.push([
          clause[0] as Expr,
          optimizeNode(clause[1] as Expr, index, fired, typeInfo),
        ] as Expr);
      }
      return out;
    }
    case "handle": {
      const out: Expr[] = [op, optimizeNode(expr[1] as Expr, index, fired, typeInfo)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        out.push([
          clause[0] as Expr,
          optimizeNode(clause[1] as Expr, index, fired, typeInfo),
        ] as Expr);
      }
      return out;
    }
    case "cond": {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        const test = clause[0];
        const body = clause[1] as Expr;
        const newTest =
          test === "else" ? "else" : optimizeNode(test as Expr, index, fired, typeInfo);
        out.push([newTest as Expr, optimizeNode(body, index, fired, typeInfo)] as Expr);
      }
      return out;
    }
    case "__loop": {
      const params = expr[1] as Expr;
      const initArgs = expr[2];
      const body = expr[3] as Expr;
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => optimizeNode(a as Expr, index, fired, typeInfo)) as Expr)
        : (initArgs as Expr);
      return [op, params, newInit, optimizeNode(body, index, fired, typeInfo)];
    }
    case "__continue":
      return [op, ...expr.slice(1).map((e) => optimizeNode(e as Expr, index, fired, typeInfo))];
    case "perform":
      // ["perform", tagString, payload]
      if (expr.length === 3) {
        return [op, expr[1] as Expr, optimizeNode(expr[2] as Expr, index, fired, typeInfo)];
      }
      return expr;
    default: {
      // Generic call: optimize all args; op stays as-is.
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        out.push(optimizeNode(expr[i] as Expr, index, fired, typeInfo));
      }
      return out;
    }
  }
}

/** Apply rules to `expr` to fixed-point at this position, after children are
 * already optimized. Returns the rewritten expression. */
function applyRulesAtNode(
  expr: Expr,
  index: Map<string, RewriteRule[]>,
  fired: WeakMap<object, Set<string>>,
  typeInfo?: TypeInfo,
): Expr {
  let current = expr;
  // Cap iterations as a sanity backstop. A correct rule set with `reducing: true`
  // strictly reduces some metric and `reducing: false` rules are guarded; the
  // termination guard below catches the common rule-authoring bugs.
  for (let iter = 0; iter < 1000; iter++) {
    if (!Array.isArray(current) || current.length === 0) return current;
    const op = current[0];
    if (typeof op !== "string") return current;
    const candidates = index.get(op);
    if (!candidates) return current;

    let fireResult: Expr | null = null;
    let firedRule: RewriteRule | null = null;
    for (const rule of candidates) {
      const bindings = rule.match(current);
      if (bindings === null) continue;
      if (rule.where && !rule.where(bindings, typeInfo)) continue;

      if (!rule.reducing) {
        // Guard: if this rule has already fired at this node identity, error.
        const key = current as unknown as object;
        const set = fired.get(key);
        if (set && set.has(rule.name)) continue;
      }

      const next = rule.rewrite(bindings);

      if (!rule.reducing) {
        const key = current as unknown as object;
        let set = fired.get(key);
        if (!set) {
          set = new Set();
          fired.set(key, set);
        }
        set.add(rule.name);
      }

      // Termination guard for `reducing: true` rules: if rewrite produced a
      // structurally identical (===) node under the same rule, that's a bug.
      if (rule.reducing && next === current) {
        throw new Error(
          `RewriteRule '${rule.name}' fired but produced the same node — ` +
            `non-reducing rule marked as reducing`,
        );
      }

      // If the result is itself a non-trivial expression, optimize its children
      // (the rewrite may have inserted unoptimized sub-trees, e.g. `if-fold`
      // returning a branch verbatim — already optimized — so this is cheap).
      // We don't recurse children here for `if`/`and`/`or`/`let` rewrites
      // because they return already-optimized sub-trees from the input.
      fireResult = next;
      firedRule = rule;
      break;
    }

    if (fireResult === null) return current;
    void firedRule;
    current = fireResult;
    // Loop: re-check rules at the new node.
  }
  throw new Error("optimizer: rule application did not terminate within 1000 iterations");
}

function optimizeNode(
  expr: Expr,
  index: Map<string, RewriteRule[]>,
  fired: WeakMap<object, Set<string>>,
  typeInfo?: TypeInfo,
): Expr {
  // Post-order: optimize children first.
  const withChildren = optimizeChildren(expr, index, fired, typeInfo);
  return applyRulesAtNode(withChildren, index, fired, typeInfo);
}

/**
 * Optimize a Marinada expression by applying rewrite rules bottom-up
 * (post-order, fixed-point per node).
 *
 * Pure: never mutates `expr`.
 */
export function optimize(expr: Expr, rules: RewriteRule[], typeInfo?: TypeInfo): Expr {
  if (rules.length === 0) return expr;
  const index = indexRules(rules);
  const fired: WeakMap<object, Set<string>> = new WeakMap();
  return optimizeNode(expr, index, fired, typeInfo);
}

// --- Phase 4: tail-call optimization ---
//
// Converts tail-recursive single-binding `letrec` forms into `__loop` /
// `__continue` nodes — the canonical loop form. After TCO, all loops have a
// single shape, which is the prerequisite for Phase 5 (loop pattern
// recognition).

/** Count free references to `name` in `expr`. Respects shadowing. */
function countFreeRefs(name: string, expr: Expr): number {
  if (typeof expr === "string") return expr === name ? 1 : 0;
  if (!Array.isArray(expr) || expr.length === 0) return 0;
  const op = expr[0];
  if (typeof op !== "string") {
    let n = 0;
    for (const e of expr) n += countFreeRefs(name, e as Expr);
    return n;
  }
  switch (op) {
    case "__lit":
      return 0;
    case "fn":
    case "fn-once": {
      const ps = paramNames(expr[1] as Expr);
      if (ps.includes(name)) return 0;
      return countFreeRefs(name, expr[2] as Expr);
    }
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return 0;
      let total = 0;
      let shadowed = false;
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) continue;
        if (!shadowed) total += countFreeRefs(name, b[1] as Expr);
        if (b[0] === name) shadowed = true;
      }
      if (!shadowed) total += countFreeRefs(name, expr[2] as Expr);
      return total;
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return 0;
      const names = bindings
        .map((b) => (Array.isArray(b) ? b[0] : null))
        .filter((n): n is string => typeof n === "string");
      if (names.includes(name)) return 0;
      let total = 0;
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) continue;
        total += countFreeRefs(name, b[1] as Expr);
      }
      total += countFreeRefs(name, expr[2] as Expr);
      return total;
    }
    case "match":
    case "handle": {
      let total = countFreeRefs(name, expr[1] as Expr);
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const pattern = clause[0];
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        if (!bound.includes(name)) total += countFreeRefs(name, body);
      }
      return total;
    }
    case "__loop": {
      const ps = paramNames(expr[1] as Expr);
      const initArgs = expr[2];
      let total = 0;
      if (Array.isArray(initArgs)) {
        for (const a of initArgs) total += countFreeRefs(name, a as Expr);
      }
      if (!ps.includes(name)) total += countFreeRefs(name, expr[3] as Expr);
      return total;
    }
    default: {
      let total = 0;
      for (let i = 1; i < expr.length; i++) total += countFreeRefs(name, expr[i] as Expr);
      return total;
    }
  }
}

/** Verify every free reference to `name` in `expr` is the head of a
 * `["call", name, ...args]` with exactly `arity` arguments. When
 * `requireTailOnly` is set, additionally require each such call to be in a
 * tail position. Used to validate the body of the recursive fn (tail-only)
 * and the entry expression (any position is fine — the call subtree gets
 * replaced wholesale by a `__loop` node). */
function checkRecCallShape(
  expr: Expr,
  name: string,
  arity: number,
  requireTailOnly: boolean,
  inTail: boolean,
): boolean {
  if (typeof expr === "string") return expr !== name;
  if (!Array.isArray(expr) || expr.length === 0) return true;
  const op = expr[0];
  if (typeof op !== "string") {
    for (const e of expr) {
      if (!checkRecCallShape(e as Expr, name, arity, requireTailOnly, false)) return false;
    }
    return true;
  }
  switch (op) {
    case "__lit":
      return true;
    case "call": {
      const head = expr[1];
      if (head === name) {
        if (requireTailOnly && !inTail) return false;
        if (expr.length - 2 !== arity) return false;
        for (let i = 2; i < expr.length; i++) {
          if (!checkRecCallShape(expr[i] as Expr, name, arity, requireTailOnly, false))
            return false;
        }
        return true;
      }
      for (let i = 1; i < expr.length; i++) {
        if (!checkRecCallShape(expr[i] as Expr, name, arity, requireTailOnly, false)) return false;
      }
      return true;
    }
    case "if": {
      if (expr.length !== 4) {
        for (let i = 1; i < expr.length; i++) {
          if (!checkRecCallShape(expr[i] as Expr, name, arity, requireTailOnly, false))
            return false;
        }
        return true;
      }
      if (!checkRecCallShape(expr[1] as Expr, name, arity, requireTailOnly, false)) return false;
      if (!checkRecCallShape(expr[2] as Expr, name, arity, requireTailOnly, inTail)) return false;
      if (!checkRecCallShape(expr[3] as Expr, name, arity, requireTailOnly, inTail)) return false;
      return true;
    }
    case "do": {
      for (let i = 1; i < expr.length - 1; i++) {
        if (!checkRecCallShape(expr[i] as Expr, name, arity, requireTailOnly, false)) return false;
      }
      if (expr.length >= 2) {
        if (!checkRecCallShape(expr[expr.length - 1] as Expr, name, arity, requireTailOnly, inTail))
          return false;
      }
      return true;
    }
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return true;
      let shadowed = false;
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) continue;
        if (!shadowed) {
          if (!checkRecCallShape(b[1] as Expr, name, arity, requireTailOnly, false)) return false;
        }
        if (b[0] === name) shadowed = true;
      }
      if (shadowed) return true;
      return checkRecCallShape(expr[2] as Expr, name, arity, requireTailOnly, inTail);
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return true;
      const names = bindings
        .map((b) => (Array.isArray(b) ? b[0] : null))
        .filter((n): n is string => typeof n === "string");
      if (names.includes(name)) return true;
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) continue;
        if (!checkRecCallShape(b[1] as Expr, name, arity, requireTailOnly, false)) return false;
      }
      return checkRecCallShape(expr[2] as Expr, name, arity, requireTailOnly, inTail);
    }
    case "fn":
    case "fn-once": {
      const ps = paramNames(expr[1] as Expr);
      if (ps.includes(name)) return true;
      return checkRecCallShape(expr[2] as Expr, name, arity, requireTailOnly, false);
    }
    case "match":
    case "handle": {
      if (!checkRecCallShape(expr[1] as Expr, name, arity, requireTailOnly, false)) return false;
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const pattern = clause[0];
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        if (bound.includes(name)) continue;
        if (!checkRecCallShape(body, name, arity, requireTailOnly, inTail)) return false;
      }
      return true;
    }
    case "cond": {
      for (let i = 1; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) continue;
        const test = clause[0];
        const body = clause[1] as Expr;
        if (test !== "else") {
          if (!checkRecCallShape(test as Expr, name, arity, requireTailOnly, false)) return false;
        }
        if (!checkRecCallShape(body, name, arity, requireTailOnly, inTail)) return false;
      }
      return true;
    }
    case "__loop": {
      const ps = paramNames(expr[1] as Expr);
      const initArgs = expr[2];
      if (Array.isArray(initArgs)) {
        for (const a of initArgs) {
          if (!checkRecCallShape(a as Expr, name, arity, requireTailOnly, false)) return false;
        }
      }
      if (ps.includes(name)) return true;
      return checkRecCallShape(expr[3] as Expr, name, arity, requireTailOnly, inTail);
    }
    default: {
      for (let i = 1; i < expr.length; i++) {
        if (!checkRecCallShape(expr[i] as Expr, name, arity, requireTailOnly, false)) return false;
      }
      return true;
    }
  }
}

/** Replace tail-position `["call", name, ...args]` with `["__continue", ...args]`. */
function replaceTailCallsWithContinue(expr: Expr, name: string, inTail: boolean): Expr {
  if (typeof expr === "string") return expr;
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => replaceTailCallsWithContinue(e as Expr, name, false)) as Expr;
  }
  switch (op) {
    case "__lit":
      return expr;
    case "call": {
      const head = expr[1];
      if (head === name && inTail) {
        const newArgs = expr
          .slice(2)
          .map((a) => replaceTailCallsWithContinue(a as Expr, name, false));
        return ["__continue", ...newArgs];
      }
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        out.push(replaceTailCallsWithContinue(expr[i] as Expr, name, false));
      }
      return out;
    }
    case "if": {
      if (expr.length !== 4) {
        return expr.map((e, i) =>
          i === 0 ? e : replaceTailCallsWithContinue(e as Expr, name, false),
        ) as Expr;
      }
      return [
        op,
        replaceTailCallsWithContinue(expr[1] as Expr, name, false),
        replaceTailCallsWithContinue(expr[2] as Expr, name, inTail),
        replaceTailCallsWithContinue(expr[3] as Expr, name, inTail),
      ];
    }
    case "do": {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        const isLast = i === expr.length - 1;
        out.push(replaceTailCallsWithContinue(expr[i] as Expr, name, isLast && inTail));
      }
      return out;
    }
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      let shadowed = false;
      const newBindings: Expr[] = [];
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) {
          newBindings.push(b as Expr);
          continue;
        }
        const bName = b[0] as string;
        const bVal = shadowed
          ? (b[1] as Expr)
          : replaceTailCallsWithContinue(b[1] as Expr, name, false);
        newBindings.push([bName, bVal] as Expr);
        if (bName === name) shadowed = true;
      }
      const newBody = shadowed
        ? (expr[2] as Expr)
        : replaceTailCallsWithContinue(expr[2] as Expr, name, inTail);
      return [op, newBindings as Expr, newBody];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const names = bindings
        .map((b) => (Array.isArray(b) ? b[0] : null))
        .filter((n): n is string => typeof n === "string");
      if (names.includes(name)) return expr;
      const newBindings = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, replaceTailCallsWithContinue(b[1] as Expr, name, false)] as Expr;
      });
      return [op, newBindings as Expr, replaceTailCallsWithContinue(expr[2] as Expr, name, inTail)];
    }
    case "fn":
    case "fn-once": {
      const ps = paramNames(expr[1] as Expr);
      if (ps.includes(name)) return expr;
      return [op, expr[1] as Expr, replaceTailCallsWithContinue(expr[2] as Expr, name, false)];
    }
    case "match":
    case "handle": {
      const out: Expr[] = [op, replaceTailCallsWithContinue(expr[1] as Expr, name, false)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        const pattern = clause[0] as Expr;
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        const newBody = bound.includes(name)
          ? body
          : replaceTailCallsWithContinue(body, name, inTail);
        out.push([pattern, newBody] as Expr);
      }
      return out;
    }
    case "cond": {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        const test = clause[0];
        const body = clause[1] as Expr;
        const newTest =
          test === "else" ? "else" : replaceTailCallsWithContinue(test as Expr, name, false);
        out.push([newTest as Expr, replaceTailCallsWithContinue(body, name, inTail)] as Expr);
      }
      return out;
    }
    case "__loop": {
      const ps = paramNames(expr[1] as Expr);
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => replaceTailCallsWithContinue(a as Expr, name, false)) as Expr)
        : (initArgs as Expr);
      const body = expr[3] as Expr;
      const newBody = ps.includes(name) ? body : replaceTailCallsWithContinue(body, name, inTail);
      return [op, expr[1] as Expr, newInit, newBody];
    }
    default: {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        out.push(replaceTailCallsWithContinue(expr[i] as Expr, name, false));
      }
      return out;
    }
  }
}

/** Replace each `["call", name, ...args]` in `expr` with `makeLoop(args)`.
 * Respects shadowing. */
function replaceCallsWithLoop(expr: Expr, name: string, makeLoop: (args: Expr[]) => Expr): Expr {
  if (typeof expr === "string") return expr;
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => replaceCallsWithLoop(e as Expr, name, makeLoop)) as Expr;
  }
  if (op === "__lit") return expr;
  if (op === "call" && expr[1] === name) {
    const args = expr.slice(2).map((a) => replaceCallsWithLoop(a as Expr, name, makeLoop));
    return makeLoop(args);
  }
  switch (op) {
    case "fn":
    case "fn-once": {
      const ps = paramNames(expr[1] as Expr);
      if (ps.includes(name)) return expr;
      return [op, expr[1] as Expr, replaceCallsWithLoop(expr[2] as Expr, name, makeLoop)];
    }
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      let shadowed = false;
      const newBindings: Expr[] = [];
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) {
          newBindings.push(b as Expr);
          continue;
        }
        const bName = b[0] as string;
        const bVal = shadowed ? (b[1] as Expr) : replaceCallsWithLoop(b[1] as Expr, name, makeLoop);
        newBindings.push([bName, bVal] as Expr);
        if (bName === name) shadowed = true;
      }
      const newBody = shadowed
        ? (expr[2] as Expr)
        : replaceCallsWithLoop(expr[2] as Expr, name, makeLoop);
      return [op, newBindings as Expr, newBody];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const names = bindings
        .map((b) => (Array.isArray(b) ? b[0] : null))
        .filter((n): n is string => typeof n === "string");
      if (names.includes(name)) return expr;
      const newBindings = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, replaceCallsWithLoop(b[1] as Expr, name, makeLoop)] as Expr;
      });
      return [op, newBindings as Expr, replaceCallsWithLoop(expr[2] as Expr, name, makeLoop)];
    }
    case "match":
    case "handle": {
      const out: Expr[] = [op, replaceCallsWithLoop(expr[1] as Expr, name, makeLoop)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        const pattern = clause[0] as Expr;
        const body = clause[1] as Expr;
        const bound = Array.isArray(pattern)
          ? pattern.slice(1).filter((s): s is string => typeof s === "string")
          : [];
        const newBody = bound.includes(name) ? body : replaceCallsWithLoop(body, name, makeLoop);
        out.push([pattern, newBody] as Expr);
      }
      return out;
    }
    case "__loop": {
      const ps = paramNames(expr[1] as Expr);
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => replaceCallsWithLoop(a as Expr, name, makeLoop)) as Expr)
        : (initArgs as Expr);
      const body = expr[3] as Expr;
      const newBody = ps.includes(name) ? body : replaceCallsWithLoop(body, name, makeLoop);
      return [op, expr[1] as Expr, newInit, newBody];
    }
    default: {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        out.push(replaceCallsWithLoop(expr[i] as Expr, name, makeLoop));
      }
      return out;
    }
  }
}

/** Try to TCO a single-binding letrec. Returns rewritten expr or null. */
function tryTcoLetrec(expr: Expr): Expr | null {
  if (!Array.isArray(expr) || expr.length !== 3 || expr[0] !== "letrec") return null;
  const bindings = expr[1];
  const entry = expr[2] as Expr;
  if (!Array.isArray(bindings) || bindings.length !== 1) return null;
  const binding = bindings[0];
  if (!Array.isArray(binding) || binding.length !== 2) return null;
  const name = binding[0];
  if (typeof name !== "string") return null;
  const fnExpr = binding[1] as Expr;
  if (!Array.isArray(fnExpr) || fnExpr.length !== 3 || fnExpr[0] !== "fn") return null;
  const paramsExpr = fnExpr[1];
  if (!Array.isArray(paramsExpr)) return null;
  const params: string[] = [];
  for (const p of paramsExpr) {
    if (typeof p === "string") params.push(p);
    else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") params.push(p[0]);
    else return null;
  }
  if (params.includes(name)) return null;
  const body = fnExpr[2] as Expr;
  const arity = params.length;

  if (!checkRecCallShape(body, name, arity, true, true)) return null;
  if (!checkRecCallShape(entry, name, arity, false, true)) return null;
  if (countFreeRefs(name, entry) === 0) return null;
  if (countFreeRefs(name, body) === 0) return null;

  const transformedBody = replaceTailCallsWithContinue(body, name, true);
  if (countFreeRefs(name, transformedBody) !== 0) return null;

  const makeLoop = (args: Expr[]): Expr => {
    if (args.length !== arity) return ["call", name, ...args];
    return ["__loop", params as Expr, args as Expr, transformedBody];
  };

  return replaceCallsWithLoop(entry, name, makeLoop);
}

/** Tail-call optimization pass. Walks bottom-up converting tail-recursive
 * single-binding letrec forms into `__loop` / `__continue` nodes. */
export function tco(expr: Expr): Expr {
  if (typeof expr === "string" || expr === null) return expr;
  if (typeof expr === "boolean" || typeof expr === "number") return expr;
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => tco(e as Expr)) as Expr;
  }
  switch (op) {
    case "__lit":
      return expr;
    case "fn":
    case "fn-once":
      return [op, expr[1] as Expr, tco(expr[2] as Expr)];
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newBindings = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, tco(b[1] as Expr)] as Expr;
      });
      return [op, newBindings as Expr, tco(expr[2] as Expr)];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newBindings = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, tco(b[1] as Expr)] as Expr;
      });
      const recursed: Expr = [op, newBindings as Expr, tco(expr[2] as Expr)];
      const transformed = tryTcoLetrec(recursed);
      return transformed !== null ? transformed : recursed;
    }
    case "match":
    case "handle": {
      const out: Expr[] = [op, tco(expr[1] as Expr)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        out.push([clause[0] as Expr, tco(clause[1] as Expr)] as Expr);
      }
      return out;
    }
    case "cond": {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        const test = clause[0];
        const body = clause[1] as Expr;
        const newTest = test === "else" ? "else" : tco(test as Expr);
        out.push([newTest as Expr, tco(body)] as Expr);
      }
      return out;
    }
    case "__loop": {
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => tco(a as Expr)) as Expr)
        : (initArgs as Expr);
      return [op, expr[1] as Expr, newInit, tco(expr[3] as Expr)];
    }
    case "perform":
      if (expr.length === 3) return [op, expr[1] as Expr, tco(expr[2] as Expr)];
      return expr;
    default: {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) out.push(tco(expr[i] as Expr));
      return out;
    }
  }
}

// --- Phase 6: function inlining ---
//
// Inlines `let`-bound (or `letrec`-bound) functions at single call sites when
// the body is small, pure, and non-looping. This is intentionally surgical:
// only fires when it's clearly beneficial (no code duplication, no effect
// reordering, no loop unrolling). Tiny lib:std combinators like `identity`,
// `const`, and `flip` qualify; recursive helpers (`map`, `filter`, etc.) do
// not because their bodies contain `letrec`.

const INLINE_SIZE_THRESHOLD = 10;

/** Count AST nodes in `expr` (atoms count as 1). */
function astSize(expr: Expr): number {
  if (!Array.isArray(expr)) return 1;
  let n = 1;
  for (const c of expr) n += astSize(c as Expr);
  return n;
}

/** True if `body` qualifies as a "small, non-looping, pure" function body
 * suitable for inlining. */
function isInlineableBody(body: Expr): boolean {
  if (hasEffects(body)) return false;
  if (containsBlocked(body)) return false;
  if (astSize(body) > INLINE_SIZE_THRESHOLD) return false;
  return true;
}

/** True if `expr` contains any construct that disqualifies inlining:
 * `letrec` (loops), nested `call` to another function (one-level limit),
 * `perform`, `handle`, `__loop`, `__continue`. */
function containsBlocked(expr: Expr): boolean {
  if (!Array.isArray(expr) || expr.length === 0) return false;
  const op = expr[0];
  if (typeof op === "string") {
    if (
      op === "letrec" ||
      op === "perform" ||
      op === "handle" ||
      op === "__loop" ||
      op === "__continue" ||
      op === "call"
    ) {
      return true;
    }
  }
  for (let i = 1; i < expr.length; i++) {
    if (containsBlocked(expr[i] as Expr)) return true;
  }
  return false;
}

/** Count call sites of the form `["call", name, ...]` referencing `name` as a
 * bare variable. Also counts other free uses of `name` (in non-call position),
 * since those would prevent inlining (the function escapes). Returns
 * { calls, otherUses } so callers can require otherUses === 0 and calls === 1. */
function countUses(name: string, expr: Expr): { calls: number; otherUses: number } {
  let calls = 0;
  let otherUses = 0;
  function visit(e: Expr, asCallee: boolean): void {
    if (typeof e === "string") {
      if (e === name && !asCallee) otherUses++;
      return;
    }
    if (!Array.isArray(e) || e.length === 0) return;
    const op = e[0];
    if (typeof op !== "string") {
      for (const c of e) visit(c as Expr, false);
      return;
    }
    switch (op) {
      case "__lit":
        return;
      case "fn":
      case "fn-once": {
        const ps = paramNames(e[1] as Expr);
        if (ps.includes(name)) return;
        visit(e[2] as Expr, false);
        return;
      }
      case "let": {
        const bindings = e[1];
        if (!Array.isArray(bindings)) return;
        let shadowed = false;
        for (const b of bindings) {
          if (!Array.isArray(b) || b.length !== 2) continue;
          if (!shadowed) visit(b[1] as Expr, false);
          if (b[0] === name) shadowed = true;
        }
        if (!shadowed) visit(e[2] as Expr, false);
        return;
      }
      case "letrec": {
        const bindings = e[1];
        if (!Array.isArray(bindings)) return;
        const names = bindings
          .map((b) => (Array.isArray(b) ? b[0] : null))
          .filter((n): n is string => typeof n === "string");
        if (names.includes(name)) return;
        for (const b of bindings) {
          if (!Array.isArray(b) || b.length !== 2) continue;
          visit(b[1] as Expr, false);
        }
        visit(e[2] as Expr, false);
        return;
      }
      case "match":
      case "handle": {
        visit(e[1] as Expr, false);
        for (let i = 2; i < e.length; i++) {
          const clause = e[i];
          if (!Array.isArray(clause) || clause.length !== 2) continue;
          const pattern = clause[0];
          const body = clause[1] as Expr;
          const bound = Array.isArray(pattern)
            ? pattern.slice(1).filter((s): s is string => typeof s === "string")
            : [];
          if (!bound.includes(name)) visit(body, false);
        }
        return;
      }
      case "__loop": {
        const ps = paramNames(e[1] as Expr);
        const initArgs = e[2];
        if (Array.isArray(initArgs)) {
          for (const a of initArgs) visit(a as Expr, false);
        }
        if (!ps.includes(name)) visit(e[3] as Expr, false);
        return;
      }
      case "call": {
        // First arg is the callee.
        if (e.length >= 2) {
          const callee = e[1];
          if (typeof callee === "string" && callee === name) {
            calls++;
          } else {
            visit(callee as Expr, false);
          }
          for (let i = 2; i < e.length; i++) visit(e[i] as Expr, false);
        }
        return;
      }
      default:
        for (let i = 1; i < e.length; i++) visit(e[i] as Expr, false);
        return;
    }
  }
  visit(expr, false);
  return { calls, otherUses };
}

/** Generate a fresh name based on `base` not in `taken`. Mutates `taken` to
 * include the result. */
function freshName(base: string, taken: Set<string>): string {
  let i = 0;
  let candidate = `${base}__inl${i}`;
  while (taken.has(candidate)) {
    i++;
    candidate = `${base}__inl${i}`;
  }
  taken.add(candidate);
  return candidate;
}

/** Collect every name that appears (free or bound) in `expr` — used to seed
 * the `taken` set for fresh-name generation during alpha-renaming. */
function collectAllNames(expr: Expr, out: Set<string>): void {
  if (typeof expr === "string") {
    out.add(expr);
    return;
  }
  if (!Array.isArray(expr) || expr.length === 0) return;
  const op = expr[0];
  if (typeof op === "string") {
    switch (op) {
      case "__lit":
        return;
      case "fn":
      case "fn-once": {
        for (const n of paramNames(expr[1] as Expr)) out.add(n);
        collectAllNames(expr[2] as Expr, out);
        return;
      }
      case "let":
      case "letrec": {
        const bindings = expr[1];
        if (Array.isArray(bindings)) {
          for (const b of bindings) {
            if (Array.isArray(b) && b.length === 2) {
              if (typeof b[0] === "string") out.add(b[0]);
              collectAllNames(b[1] as Expr, out);
            }
          }
        }
        collectAllNames(expr[2] as Expr, out);
        return;
      }
    }
  }
  for (let i = 1; i < expr.length; i++) collectAllNames(expr[i] as Expr, out);
}

/** Alpha-rename all bound variables in `expr` to fresh names not in `taken`.
 * Free variables are left alone. Used before substitution to prevent capture. */
function alphaRename(expr: Expr, taken: Set<string>, env: Map<string, string>): Expr {
  if (typeof expr === "string") {
    const r = env.get(expr);
    return r === undefined ? expr : r;
  }
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => alphaRename(e as Expr, taken, env)) as Expr;
  }

  switch (op) {
    case "__lit":
      return expr;
    case "fn":
    case "fn-once": {
      const params = expr[1];
      const newEnv = new Map(env);
      let newParams: Expr;
      if (Array.isArray(params)) {
        newParams = params.map((p) => {
          if (typeof p === "string") {
            const fresh = freshName(p, taken);
            newEnv.set(p, fresh);
            return fresh;
          }
          if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") {
            const fresh = freshName(p[0], taken);
            newEnv.set(p[0], fresh);
            return [fresh, ...p.slice(1)] as Expr;
          }
          return p as Expr;
        }) as Expr;
      } else {
        newParams = params as Expr;
      }
      return [op, newParams, alphaRename(expr[2] as Expr, taken, newEnv)];
    }
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const currentEnv = new Map(env);
      const newBindings: Expr[] = [];
      for (const b of bindings) {
        if (!Array.isArray(b) || b.length !== 2) {
          newBindings.push(b as Expr);
          continue;
        }
        const bName = b[0] as string;
        const newVal = alphaRename(b[1] as Expr, taken, currentEnv);
        const fresh = freshName(bName, taken);
        currentEnv.set(bName, fresh);
        newBindings.push([fresh, newVal] as Expr);
      }
      return ["let", newBindings as Expr, alphaRename(expr[2] as Expr, taken, currentEnv)];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newEnv = new Map(env);
      const renamed: string[] = [];
      for (const b of bindings) {
        if (Array.isArray(b) && b.length === 2 && typeof b[0] === "string") {
          const fresh = freshName(b[0], taken);
          newEnv.set(b[0], fresh);
          renamed.push(fresh);
        } else {
          renamed.push("");
        }
      }
      const newBindings: Expr[] = bindings.map((b, i) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [renamed[i] as string, alphaRename(b[1] as Expr, taken, newEnv)] as Expr;
      });
      return ["letrec", newBindings as Expr, alphaRename(expr[2] as Expr, taken, newEnv)];
    }
    case "match":
    case "handle": {
      const out: Expr[] = [op, alphaRename(expr[1] as Expr, taken, env)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        const pattern = clause[0] as Expr;
        const body = clause[1] as Expr;
        const newEnv = new Map(env);
        let newPattern: Expr = pattern;
        if (Array.isArray(pattern)) {
          newPattern = [
            pattern[0],
            ...pattern.slice(1).map((p) => {
              if (typeof p === "string") {
                const fresh = freshName(p, taken);
                newEnv.set(p, fresh);
                return fresh;
              }
              return p as Expr;
            }),
          ] as Expr;
        }
        out.push([newPattern, alphaRename(body, taken, newEnv)] as Expr);
      }
      return out;
    }
    case "__loop": {
      const params = expr[1];
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => alphaRename(a as Expr, taken, env)) as Expr)
        : (initArgs as Expr);
      const newEnv = new Map(env);
      let newParams: Expr;
      if (Array.isArray(params)) {
        newParams = params.map((p) => {
          if (typeof p === "string") {
            const fresh = freshName(p, taken);
            newEnv.set(p, fresh);
            return fresh;
          }
          return p as Expr;
        }) as Expr;
      } else {
        newParams = params as Expr;
      }
      return [op, newParams, newInit, alphaRename(expr[3] as Expr, taken, newEnv)];
    }
    default:
      return expr.map((e) => alphaRename(e as Expr, taken, env)) as Expr;
  }
}

/** Inline `["call", name, arg1, ...]` where `fn = ["fn", params, body]`,
 * by substituting params with args in an alpha-renamed body. Returns null if
 * arity doesn't match. */
function inlineCall(fn: Expr, args: Expr[], outerTaken: Set<string>): Expr | null {
  if (!Array.isArray(fn) || fn[0] !== "fn") return null;
  const params = fn[1];
  const body = fn[2] as Expr;
  if (!Array.isArray(params)) return null;
  const paramNs: string[] = [];
  for (const p of params) {
    if (typeof p === "string") paramNs.push(p);
    else if (Array.isArray(p) && p.length >= 1 && typeof p[0] === "string") paramNs.push(p[0]);
    else return null;
  }
  if (paramNs.length !== args.length) return null;

  // Build the taken set: outerTaken ∪ all names in body ∪ all names in args.
  const taken = new Set(outerTaken);
  collectAllNames(body, taken);
  for (const a of args) collectAllNames(a, taken);
  for (const p of paramNs) taken.add(p);

  // Alpha-rename the body so its bound names don't collide with anything.
  // We start with a fresh env: params keep their original names so we can
  // substitute them, but the rest of the body's bound vars get fresh names.
  // To do this cleanly: alpha-rename, but seed env with identity for params.
  // Simpler: alpha-rename the whole body; params get renamed too; track their
  // new names; then substitute new-param-name → arg.
  const env = new Map<string, string>();
  const renamedBody = alphaRename(body, taken, env);
  // After alphaRename, params have been renamed. But we built `env` empty —
  // alphaRename traverses from the top; since `body` is the raw fn body, its
  // free uses of params won't be in `env` yet. We need to rename the params
  // explicitly first.
  // Simpler approach: do it manually here.
  const env2 = new Map<string, string>();
  const newParamNames: string[] = [];
  for (const p of paramNs) {
    const fresh = freshName(p, taken);
    env2.set(p, fresh);
    newParamNames.push(fresh);
  }
  const renamed = alphaRename(body, taken, env2);
  void renamedBody;

  // Substitute fresh param name → arg in `renamed`.
  let result = renamed;
  for (let i = 0; i < newParamNames.length; i++) {
    result = substitute(result, newParamNames[i] as string, args[i] as Expr);
  }
  return result;
}

/** Walk `expr` and inline single-use small functions bound by `let`/`letrec`. */
export function inlineSmallFunctions(expr: Expr): Expr {
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => inlineSmallFunctions(e as Expr)) as Expr;
  }

  // First, recurse into children.
  const recurseChildren = (e: Expr): Expr => inlineSmallFunctions(e);

  switch (op) {
    case "__lit":
      return expr;
    case "let": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      // Optimize children first.
      const newBindings: Expr[] = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, recurseChildren(b[1] as Expr)] as Expr;
      });
      let body = recurseChildren(expr[2] as Expr);

      // Now scan bindings (in scope order) for inlineable small functions.
      // Build the "scope after binding i" — for simplicity, only handle
      // bindings whose scope is exactly `body` (i.e. last binding, or none of
      // the later bindings reference the candidate). Conservative but covers
      // the common case.
      const kept: Expr[] = [];
      for (let i = 0; i < newBindings.length; i++) {
        const b = newBindings[i];
        if (!Array.isArray(b) || b.length !== 2) {
          kept.push(b as Expr);
          continue;
        }
        const name = b[0] as string;
        const val = b[1] as Expr;

        // Candidate iff val is ["fn", params, fnBody] with small/pure/no-loop body.
        if (
          !Array.isArray(val) ||
          val[0] !== "fn" ||
          !Array.isArray(val[1]) ||
          !isInlineableBody(val[2] as Expr)
        ) {
          kept.push(b as Expr);
          continue;
        }

        // Determine scope: later bindings' values + body. To keep things
        // simple and safe, only inline if the candidate is unused in the
        // remaining bindings (i.e. only used in `body`).
        let usedInLater = false;
        for (let j = i + 1; j < newBindings.length; j++) {
          const bj = newBindings[j];
          if (Array.isArray(bj) && bj.length === 2 && freeIn(name, bj[1] as Expr)) {
            usedInLater = true;
            break;
          }
        }
        if (usedInLater) {
          kept.push(b as Expr);
          continue;
        }

        const { calls, otherUses } = countUses(name, body);
        if (otherUses !== 0 || calls !== 1) {
          kept.push(b as Expr);
          continue;
        }

        // Inline: replace the single ["call", name, ...args] call site in body.
        const inlined = replaceCall(body, name, val);
        if (inlined === null) {
          kept.push(b as Expr);
          continue;
        }
        body = inlined;
        // Drop the binding (its single use has been inlined).
      }

      if (kept.length === 0) return body;
      return ["let", kept as Expr, body];
    }
    case "letrec": {
      const bindings = expr[1];
      if (!Array.isArray(bindings)) return expr;
      const newBindings: Expr[] = bindings.map((b) => {
        if (!Array.isArray(b) || b.length !== 2) return b as Expr;
        return [b[0] as string, recurseChildren(b[1] as Expr)] as Expr;
      });
      const body = recurseChildren(expr[2] as Expr);
      // letrec bindings can be self/mutually recursive, which usually means a
      // letrec body — disqualifying for inlining. Be conservative: don't
      // inline letrec bindings here.
      return ["letrec", newBindings as Expr, body];
    }
    case "fn":
    case "fn-once":
      return [op, expr[1] as Expr, recurseChildren(expr[2] as Expr)];
    case "match":
    case "handle": {
      const out: Expr[] = [op, recurseChildren(expr[1] as Expr)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        out.push([clause[0] as Expr, recurseChildren(clause[1] as Expr)] as Expr);
      }
      return out;
    }
    case "__loop": {
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => recurseChildren(a as Expr)) as Expr)
        : (initArgs as Expr);
      return [op, expr[1] as Expr, newInit, recurseChildren(expr[3] as Expr)];
    }
    default: {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) out.push(recurseChildren(expr[i] as Expr));
      return out;
    }
  }
}

/** Find the (single) `["call", name, ...args]` site in `expr` and replace it
 * with the inlined body. Returns null if not found or shadowing prevents
 * substitution. */
function replaceCall(expr: Expr, name: string, fn: Expr): Expr | null {
  // Build the outer "taken" set once (names visible at the inline site
  // matters for fresh-name generation). We approximate by collecting all names
  // in `expr` plus the function body itself.
  const taken = new Set<string>();
  collectAllNames(expr, taken);
  collectAllNames(fn, taken);

  let replaced = false;
  function go(e: Expr): Expr {
    if (replaced) return e;
    if (typeof e === "string") return e;
    if (!Array.isArray(e) || e.length === 0) return e;
    const op = e[0];
    if (typeof op !== "string") return e.map(go) as Expr;
    // Stop at scopes that shadow `name`.
    switch (op) {
      case "__lit":
        return e;
      case "fn":
      case "fn-once": {
        const ps = paramNames(e[1] as Expr);
        if (ps.includes(name)) return e;
        return [op, e[1] as Expr, go(e[2] as Expr)];
      }
      case "let": {
        const bindings = e[1];
        if (!Array.isArray(bindings)) return e;
        const newBindings: Expr[] = [];
        let shadowed = false;
        for (const b of bindings) {
          if (!Array.isArray(b) || b.length !== 2) {
            newBindings.push(b as Expr);
            continue;
          }
          const bName = b[0] as string;
          const newVal = shadowed ? (b[1] as Expr) : go(b[1] as Expr);
          newBindings.push([bName, newVal] as Expr);
          if (bName === name) shadowed = true;
        }
        const newBody = shadowed ? (e[2] as Expr) : go(e[2] as Expr);
        return ["let", newBindings as Expr, newBody];
      }
      case "letrec": {
        const bindings = e[1];
        if (!Array.isArray(bindings)) return e;
        const ns = bindings
          .map((b) => (Array.isArray(b) ? b[0] : null))
          .filter((n): n is string => typeof n === "string");
        if (ns.includes(name)) return e;
        const newBindings = bindings.map((b) => {
          if (!Array.isArray(b) || b.length !== 2) return b as Expr;
          return [b[0] as string, go(b[1] as Expr)] as Expr;
        });
        return ["letrec", newBindings as Expr, go(e[2] as Expr)];
      }
      case "call": {
        if (e.length >= 2 && e[1] === name) {
          const args = e.slice(2) as Expr[];
          // Recurse into args first (they may contain unrelated work).
          const argsGo = args.map(go);
          const inlined = inlineCall(fn, argsGo, taken);
          if (inlined !== null) {
            replaced = true;
            return inlined;
          }
          return [op, e[1] as Expr, ...argsGo] as Expr;
        }
        return e.map(go) as Expr;
      }
      default:
        return e.map(go) as Expr;
    }
  }
  const result = go(expr);
  return replaced ? result : null;
}

// --- Phase 5: loop pattern recognition ---
//
// Inspects `__loop` nodes and replaces them with `__native` nodes when they
// match a known loop shape (array-map, array-filter, array-reduce, ...).
// Fires on ANY structurally matching loop — does not check the binding name.

/** Treat both AST atoms (0, 1, ...) and `["__lit", n]` as numeric constants. */
function isZero(e: Expr): boolean {
  if (e === 0) return true;
  if (Array.isArray(e) && e.length === 2 && e[0] === "__lit") {
    const v = e[1];
    if (v === 0) return true;
    // bigint 0 is not representable as Expr; check via constants helper
  }
  return false;
}

function isOne(e: Expr): boolean {
  if (e === 1) return true;
  if (Array.isArray(e) && e.length === 2 && e[0] === "__lit") {
    if (e[1] === 1) return true;
  }
  return false;
}

/** True if `e` is a `["__lit", []]` empty-array literal, or the bare AST form. */
function isEmptyArrayInit(e: Expr): boolean {
  if (Array.isArray(e) && e.length === 2 && e[0] === "__lit") {
    const v = e[1];
    if (Array.isArray(v) && v.length === 0) return true;
  }
  if (Array.isArray(e) && e.length === 1 && e[0] === "array") return true;
  return false;
}

/** Match `["+", x, 1]` or `["+", 1, x]` returning `x` if so. */
function matchIncrement(e: Expr, varName: string): boolean {
  if (!Array.isArray(e) || e.length !== 3 || e[0] !== "+") return false;
  if (e[1] === varName && isOne(e[2] as Expr)) return true;
  if (e[2] === varName && isOne(e[1] as Expr)) return true;
  return false;
}

/** Match `["==", I, ["count", XS]]` or symmetric. */
function matchExhaustionTest(e: Expr, iName: string, xsName: string): boolean {
  if (!Array.isArray(e) || e.length !== 3 || e[0] !== "==") return false;
  const isCount = (x: Expr): boolean =>
    Array.isArray(x) && x.length === 2 && x[0] === "count" && x[1] === xsName;
  if (e[1] === iName && isCount(e[2] as Expr)) return true;
  if (e[2] === iName && isCount(e[1] as Expr)) return true;
  return false;
}

/** Match `["array-get", XS, I]`. */
function matchArrayGet(e: Expr, xsName: string, iName: string): boolean {
  return (
    Array.isArray(e) && e.length === 3 && e[0] === "array-get" && e[1] === xsName && e[2] === iName
  );
}

/** Decompose a `__loop` body matching the array-map shape. Returns the
 * per-element transform expression (in terms of the loop's element-access
 * sub-expression `["array-get", XS, I]`). The actual user function is
 * obtained from the loop's first init-arg. */
type LoopInfo = {
  fName: string;
  xsName: string;
  accName: string;
  iName: string;
  fInit: Expr;
  xsInit: Expr;
  accInit: Expr;
};

/** Validate the standard 4-param `(f, xs, acc, i)` loop header and return
 * the names + inits, or null. */
function loopHeader(loop: Expr[]): LoopInfo | null {
  if (loop[0] !== "__loop") return null;
  const params = loop[1];
  const initArgs = loop[2];
  if (!Array.isArray(params) || !Array.isArray(initArgs)) return null;
  if (params.length !== 4 || initArgs.length !== 4) return null;
  const fName = params[0];
  const xsName = params[1];
  const accName = params[2];
  const iName = params[3];
  if (
    typeof fName !== "string" ||
    typeof xsName !== "string" ||
    typeof accName !== "string" ||
    typeof iName !== "string"
  ) {
    return null;
  }
  // The 4th init must be the literal 0 (loop starts at index 0).
  if (!isZero(initArgs[3] as Expr)) return null;
  return {
    fName,
    xsName,
    accName,
    iName,
    fInit: initArgs[0] as Expr,
    xsInit: initArgs[1] as Expr,
    accInit: initArgs[2] as Expr,
  };
}

/** Match the array-map __loop shape:
 *   ["__loop", [F, XS, ACC, I], [f0, xs0, [], 0],
 *     ["if", ["==", I, ["count", XS]], ACC,
 *       ["__continue", F, XS,
 *         ["array-push", ACC, ["call", F, ["array-get", XS, I]]],
 *         ["+", I, 1]]]]
 */
function matchArrayMap(loop: Expr[]): Expr | null {
  const h = loopHeader(loop);
  if (h === null) return null;
  if (!isEmptyArrayInit(h.accInit)) return null;
  const body = loop[3];
  if (!Array.isArray(body) || body.length !== 4 || body[0] !== "if") return null;
  if (!matchExhaustionTest(body[1] as Expr, h.iName, h.xsName)) return null;
  if (body[2] !== h.accName) return null;
  const cont = body[3];
  if (!Array.isArray(cont) || cont[0] !== "__continue" || cont.length !== 5) return null;
  // F, XS, newAcc, i+1
  if (cont[1] !== h.fName) return null;
  if (cont[2] !== h.xsName) return null;
  if (!matchIncrement(cont[4] as Expr, h.iName)) return null;
  const newAcc = cont[3];
  if (!Array.isArray(newAcc) || newAcc.length !== 3 || newAcc[0] !== "array-push") return null;
  if (newAcc[1] !== h.accName) return null;
  // pushed value: ["call", F, ["array-get", XS, I]]
  const pushed = newAcc[2];
  if (!Array.isArray(pushed) || pushed.length !== 3 || pushed[0] !== "call") return null;
  if (pushed[1] !== h.fName) return null;
  if (!matchArrayGet(pushed[2] as Expr, h.xsName, h.iName)) return null;

  return ["__native", "array_map", h.xsInit, h.fInit];
}

/** Match the array-filter __loop shape:
 *   ["__loop", [F, XS, ACC, I], [f0, xs0, [], 0],
 *     ["if", ["==", I, ["count", XS]], ACC,
 *       ["let", [["item", ["array-get", XS, I]]],
 *         ["if", ["call", F, "item"],
 *           ["__continue", F, XS, ["array-push", ACC, "item"], ["+", I, 1]],
 *           ["__continue", F, XS, ACC, ["+", I, 1]]]]]]
 */
function matchArrayFilter(loop: Expr[]): Expr | null {
  const h = loopHeader(loop);
  if (h === null) return null;
  if (!isEmptyArrayInit(h.accInit)) return null;
  const body = loop[3];
  if (!Array.isArray(body) || body.length !== 4 || body[0] !== "if") return null;
  if (!matchExhaustionTest(body[1] as Expr, h.iName, h.xsName)) return null;
  if (body[2] !== h.accName) return null;
  const inner = body[3];
  // Either the "let item = array-get; if (f item) ..." shape or a direct
  // shape that inlines the item access. Accept both.
  let predExpr: Expr;
  let keepCont: Expr;
  let dropCont: Expr;
  if (Array.isArray(inner) && inner[0] === "let") {
    const bindings = inner[1];
    if (!Array.isArray(bindings) || bindings.length !== 1) return null;
    const b = bindings[0];
    if (!Array.isArray(b) || b.length !== 2) return null;
    const itemName = b[0];
    if (typeof itemName !== "string") return null;
    if (!matchArrayGet(b[1] as Expr, h.xsName, h.iName)) return null;
    const ifExpr = inner[2];
    if (!Array.isArray(ifExpr) || ifExpr.length !== 4 || ifExpr[0] !== "if") return null;
    const predCall = ifExpr[1];
    if (!Array.isArray(predCall) || predCall.length !== 3 || predCall[0] !== "call") return null;
    if (predCall[1] !== h.fName) return null;
    if (predCall[2] !== itemName) return null;
    predExpr = itemName;
    keepCont = ifExpr[2] as Expr;
    dropCont = ifExpr[3] as Expr;
    void predExpr;
    // Verify keep-continue
    if (!Array.isArray(keepCont) || keepCont[0] !== "__continue" || keepCont.length !== 5) {
      return null;
    }
    if (keepCont[1] !== h.fName || keepCont[2] !== h.xsName) return null;
    if (!matchIncrement(keepCont[4] as Expr, h.iName)) return null;
    const newAcc = keepCont[3];
    if (!Array.isArray(newAcc) || newAcc.length !== 3 || newAcc[0] !== "array-push") return null;
    if (newAcc[1] !== h.accName) return null;
    if (newAcc[2] !== itemName) return null;
    // Verify drop-continue
    if (!Array.isArray(dropCont) || dropCont[0] !== "__continue" || dropCont.length !== 5) {
      return null;
    }
    if (dropCont[1] !== h.fName || dropCont[2] !== h.xsName) return null;
    if (dropCont[3] !== h.accName) return null;
    if (!matchIncrement(dropCont[4] as Expr, h.iName)) return null;
    return ["__native", "array_filter", h.xsInit, h.fInit];
  }
  return null;
}

/** Match the array-reduce __loop shape:
 *   ["__loop", [F, XS, ACC, I], [f0, xs0, init0, 0],
 *     ["if", ["==", I, ["count", XS]], ACC,
 *       ["__continue", F, XS,
 *         ["call", F, ACC, ["array-get", XS, I]],
 *         ["+", I, 1]]]]
 */
function matchArrayReduce(loop: Expr[]): Expr | null {
  const h = loopHeader(loop);
  if (h === null) return null;
  // accInit can be anything (the user's `init` value); do not constrain.
  const body = loop[3];
  if (!Array.isArray(body) || body.length !== 4 || body[0] !== "if") return null;
  if (!matchExhaustionTest(body[1] as Expr, h.iName, h.xsName)) return null;
  if (body[2] !== h.accName) return null;
  const cont = body[3];
  if (!Array.isArray(cont) || cont[0] !== "__continue" || cont.length !== 5) return null;
  if (cont[1] !== h.fName || cont[2] !== h.xsName) return null;
  if (!matchIncrement(cont[4] as Expr, h.iName)) return null;
  const newAcc = cont[3];
  if (!Array.isArray(newAcc) || newAcc.length !== 4 || newAcc[0] !== "call") return null;
  if (newAcc[1] !== h.fName) return null;
  if (newAcc[2] !== h.accName) return null;
  if (!matchArrayGet(newAcc[3] as Expr, h.xsName, h.iName)) return null;
  // For reduce, the natives table signature is (xs, f, init).
  return ["__native", "array_reduce", h.xsInit, h.fInit, h.accInit];
}

const LOOP_PATTERNS: Array<(loop: Expr[]) => Expr | null> = [
  matchArrayMap,
  matchArrayFilter,
  matchArrayReduce,
];

/** Walk `expr` and replace any `__loop` whose shape matches a known loop
 * pattern with the corresponding `__native` invocation. */
export function recognizeLoopPatterns(expr: Expr): Expr {
  if (typeof expr === "string" || expr === null) return expr;
  if (typeof expr === "boolean" || typeof expr === "number") return expr;
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e) => recognizeLoopPatterns(e as Expr)) as Expr;
  }
  if (op === "__lit") return expr;

  // Recurse into children first (so nested loops are recognized too).
  let recursed: Expr;
  switch (op) {
    case "fn":
    case "fn-once":
      recursed = [op, expr[1] as Expr, recognizeLoopPatterns(expr[2] as Expr)];
      break;
    case "let":
    case "letrec": {
      const bindings = expr[1];
      const newBindings = Array.isArray(bindings)
        ? (bindings.map((b) => {
            if (!Array.isArray(b) || b.length !== 2) return b as Expr;
            return [b[0] as string, recognizeLoopPatterns(b[1] as Expr)] as Expr;
          }) as Expr)
        : (bindings as Expr);
      recursed = [op, newBindings, recognizeLoopPatterns(expr[2] as Expr)];
      break;
    }
    case "match":
    case "handle": {
      const out: Expr[] = [op, recognizeLoopPatterns(expr[1] as Expr)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        out.push([clause[0] as Expr, recognizeLoopPatterns(clause[1] as Expr)] as Expr);
      }
      recursed = out;
      break;
    }
    case "cond": {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        const test = clause[0];
        const body = clause[1] as Expr;
        const newTest = test === "else" ? "else" : recognizeLoopPatterns(test as Expr);
        out.push([newTest as Expr, recognizeLoopPatterns(body)] as Expr);
      }
      recursed = out;
      break;
    }
    case "__loop": {
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a) => recognizeLoopPatterns(a as Expr)) as Expr)
        : (initArgs as Expr);
      recursed = [op, expr[1] as Expr, newInit, recognizeLoopPatterns(expr[3] as Expr)];
      break;
    }
    default: {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) out.push(recognizeLoopPatterns(expr[i] as Expr));
      recursed = out;
    }
  }

  if (Array.isArray(recursed) && recursed[0] === "__loop") {
    for (const matcher of LOOP_PATTERNS) {
      const replaced = matcher(recursed as Expr[]);
      if (replaced !== null) return replaced;
    }
  }
  return recursed;
}

// --- Phase 5: Loop fusion ---

/** Build a `compose(g, f)` Marinada expression: `(fn [x] (call g (call f x)))`.
 * Picks a fresh parameter name to avoid colliding with any free variable in
 * either function body. */
function makeCompose(g: Expr, f: Expr): Expr {
  const taken = new Set<string>();
  collectAllNames(g, taken);
  collectAllNames(f, taken);
  const x = freshName("__x", taken);
  return ["fn", [x], ["call", g, ["call", f, x]]];
}

/** Build the combined-predicate expression for filter-after-filter:
 *   (fn [x] (and (call pred1 x) (call pred2 x)))
 */
function makeAndPred(pred1: Expr, pred2: Expr): Expr {
  const taken = new Set<string>();
  collectAllNames(pred1, taken);
  collectAllNames(pred2, taken);
  const x = freshName("__x", taken);
  return ["fn", [x], ["and", ["call", pred1, x], ["call", pred2, x]]];
}

/** Check whether a function-typed value at the given path can be invoked
 * without producing observable effects. Reads the inferred function type's
 * latent-effects row from `typeInfo` and returns true when that row has no
/** Try to fuse a single `__native` array operation with its (already-fused)
 * inner argument. Returns the fused expression, or null if no rule applies.
 * `path` is the path to `expr` in the post-walk tree (i.e. paths into
 * `typeInfo` reflect the SAME tree being walked). */
function tryFuseAt(expr: Expr[], path: number[], typeInfo: TypeInfo): Expr | null {
  if (expr[0] !== "__native") return null;
  const name = expr[1];
  if (typeof name !== "string") return null;

  // map-after-map / map-after-filter : __native array_map xs f
  if (name === "array_map" && expr.length === 4) {
    const xs = expr[2] as Expr;
    const f = expr[3] as Expr;
    if (Array.isArray(xs) && xs[0] === "__native") {
      const innerName = xs[1];
      // map-after-map
      if (innerName === "array_map" && xs.length === 4) {
        const ys = xs[2] as Expr;
        const g = xs[3] as Expr;
        // Both inner-g and outer-f must be pure.
        if (typeInfo.isPure([...path, 3]) && typeInfo.isPure([...path, 2, 3])) {
          return ["__native", "array_map", ys, makeCompose(f, g)];
        }
      }
      // map-after-filter → array_map_filter
      if (innerName === "array_filter" && xs.length === 4) {
        const ys = xs[2] as Expr;
        const pred = xs[3] as Expr;
        if (typeInfo.isPure([...path, 3]) && typeInfo.isPure([...path, 2, 3])) {
          return ["__native", "array_map_filter", ys, pred, f];
        }
      }
    }
  }

  // filter-after-map / filter-after-filter : __native array_filter xs pred
  if (name === "array_filter" && expr.length === 4) {
    const xs = expr[2] as Expr;
    const pred2 = expr[3] as Expr;
    if (Array.isArray(xs) && xs[0] === "__native") {
      const innerName = xs[1];
      // filter-after-map → array_filter_map
      if (innerName === "array_map" && xs.length === 4) {
        const ys = xs[2] as Expr;
        const f = xs[3] as Expr;
        if (typeInfo.isPure([...path, 3]) && typeInfo.isPure([...path, 2, 3])) {
          return ["__native", "array_filter_map", ys, f, pred2];
        }
      }
      // filter-after-filter
      if (innerName === "array_filter" && xs.length === 4) {
        const ys = xs[2] as Expr;
        const pred1 = xs[3] as Expr;
        if (typeInfo.isPure([...path, 3]) && typeInfo.isPure([...path, 2, 3])) {
          return ["__native", "array_filter", ys, makeAndPred(pred1, pred2)];
        }
      }
    }
  }

  // reduce-after-map : __native array_reduce xs f init
  if (name === "array_reduce" && expr.length === 5) {
    const xs = expr[2] as Expr;
    const f = expr[3] as Expr;
    const init = expr[4] as Expr;
    if (Array.isArray(xs) && xs[0] === "__native" && xs[1] === "array_map" && xs.length === 4) {
      const ys = xs[2] as Expr;
      const g = xs[3] as Expr;
      if (typeInfo.isPure([...path, 3]) && typeInfo.isPure([...path, 2, 3])) {
        return ["__native", "array_map_reduce", ys, g, f, init];
      }
    }
  }

  return null;
}

/** Walk `expr` bottom-up (post-order), fusing adjacent `__native` array
 * operations where safe. `typeInfo` (when supplied) is used to verify purity
 * of function arguments — its paths must correspond to `expr` as passed in.
 * Without `typeInfo`, no fusion is performed. */
export function fuseLoops(expr: Expr, typeInfo?: TypeInfo): Expr {
  if (typeInfo === undefined) return expr;
  return fuseLoopsAt(expr, [], typeInfo);
}

function fuseLoopsAt(expr: Expr, path: number[], typeInfo: TypeInfo): Expr {
  if (expr === null || typeof expr === "boolean" || typeof expr === "number") return expr;
  if (typeof expr === "string") return expr;
  if (!Array.isArray(expr) || expr.length === 0) return expr;
  const op = expr[0];
  if (typeof op !== "string") {
    return expr.map((e, i) => fuseLoopsAt(e as Expr, [...path, i], typeInfo)) as Expr;
  }
  if (op === "__lit") return expr;

  // Recurse into children first (post-order).
  let recursed: Expr;
  switch (op) {
    case "fn":
    case "fn-once":
      recursed = [op, expr[1] as Expr, fuseLoopsAt(expr[2] as Expr, [...path, 2], typeInfo)];
      break;
    case "let":
    case "letrec": {
      const bindings = expr[1];
      const newBindings = Array.isArray(bindings)
        ? (bindings.map((b, bi) => {
            if (!Array.isArray(b) || b.length !== 2) return b as Expr;
            return [
              b[0] as string,
              fuseLoopsAt(b[1] as Expr, [...path, 1, bi, 1], typeInfo),
            ] as Expr;
          }) as Expr)
        : (bindings as Expr);
      recursed = [op, newBindings, fuseLoopsAt(expr[2] as Expr, [...path, 2], typeInfo)];
      break;
    }
    case "match":
    case "handle": {
      const out: Expr[] = [op, fuseLoopsAt(expr[1] as Expr, [...path, 1], typeInfo)];
      for (let i = 2; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        out.push([
          clause[0] as Expr,
          fuseLoopsAt(clause[1] as Expr, [...path, i, 1], typeInfo),
        ] as Expr);
      }
      recursed = out;
      break;
    }
    case "cond": {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        const clause = expr[i];
        if (!Array.isArray(clause) || clause.length !== 2) {
          out.push(clause as Expr);
          continue;
        }
        const test = clause[0];
        const body = clause[1] as Expr;
        const newTest =
          test === "else" ? "else" : fuseLoopsAt(test as Expr, [...path, i, 0], typeInfo);
        out.push([newTest as Expr, fuseLoopsAt(body, [...path, i, 1], typeInfo)] as Expr);
      }
      recursed = out;
      break;
    }
    case "__loop": {
      const initArgs = expr[2];
      const newInit = Array.isArray(initArgs)
        ? (initArgs.map((a, ai) => fuseLoopsAt(a as Expr, [...path, 2, ai], typeInfo)) as Expr)
        : (initArgs as Expr);
      recursed = [
        op,
        expr[1] as Expr,
        newInit,
        fuseLoopsAt(expr[3] as Expr, [...path, 3], typeInfo),
      ];
      break;
    }
    default: {
      const out: Expr[] = [op];
      for (let i = 1; i < expr.length; i++) {
        out.push(fuseLoopsAt(expr[i] as Expr, [...path, i], typeInfo));
      }
      recursed = out;
    }
  }

  // After children are fused, attempt to fuse at this node. We only fire once
  // per node because re-firing at the same path would check purity against
  // typeInfo paths that no longer correspond to the (now-synthesized) subtree.
  if (Array.isArray(recursed) && recursed[0] === "__native") {
    const next = tryFuseAt(recursed as Expr[], path, typeInfo);
    if (next !== null) return next;
  }
  return recursed;
}

// Re-export helpers for tests.
export const __test__ = {
  freeIn,
  hasEffects,
  substitute,
  asConst,
  inlineSmallFunctions,
  countUses,
  isInlineableBody,
};
