import type { Expr } from "./types.ts";

/**
 * Collect the free variables of a Marinada expression.
 *
 * A variable is free if it appears as a string atom that is not bound by an
 * enclosing binding form (fn, let, letrec, match).
 */
export function freeVariables(expr: Expr): Set<string> {
  const result = new Set<string>();
  collect(expr, new Set(), result);
  return result;
}

function collect(expr: Expr, bound: Set<string>, out: Set<string>): void {
  if (expr === null || typeof expr === "boolean" || typeof expr === "number") {
    return;
  }
  if (typeof expr === "string") {
    if (!bound.has(expr)) out.add(expr);
    return;
  }
  // Non-array object: an opaque Value embedded directly in the expression tree
  // (e.g. a cap or fn value from the host). No free variables to extract.
  if (!Array.isArray(expr)) return;
  // Array form
  if (expr.length === 0) return;
  const [op, ...args] = expr;
  if (op === "fn") {
    // ["fn", params, body]
    const params = args[0] as string[];
    const body = args[1] as Expr;
    const innerBound = new Set(bound);
    for (const p of params) innerBound.add(p);
    collect(body, innerBound, out);
  } else if (op === "let") {
    // ["let", [[name, expr], ...], body]
    const bindings = args[0] as [string, Expr][];
    const body = args[1] as Expr;
    // Binding exprs are evaluated in the outer scope
    const innerBound = new Set(bound);
    for (const [name, bindExpr] of bindings) {
      collect(bindExpr, bound, out);
      innerBound.add(name);
    }
    collect(body, innerBound, out);
  } else if (op === "letrec") {
    // ["letrec", [[name, expr], ...], body]
    const bindings = args[0] as [string, Expr][];
    const body = args[1] as Expr;
    // All names bound in both binding exprs AND body
    const innerBound = new Set(bound);
    for (const [name] of bindings) innerBound.add(name);
    for (const [, bindExpr] of bindings) collect(bindExpr, innerBound, out);
    collect(body, innerBound, out);
  } else if (op === "match") {
    // ["match", scrutinee, clause...]
    // scrutinee is args[0], clauses are args[1..]
    const scrutinee = args[0] as Expr;
    const clauses = args.slice(1) as [[string, ...string[]], Expr][];
    collect(scrutinee, bound, out);
    for (const [[_tag, ...fields], clauseBody] of clauses) {
      const innerBound = new Set(bound);
      for (const f of fields) innerBound.add(f);
      collect(clauseBody, innerBound, out);
    }
  } else {
    // All other ops: recurse into all argument subexpressions.
    // The op string at position 0 is the operator name, not a variable reference.
    for (const sub of args) collect(sub as Expr, bound, out);
  }
}
