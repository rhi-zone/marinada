import type { Expr } from "./types.ts";
import type { EvalResult, Effect } from "./evaluate.ts";
import type { Env } from "./env.ts";

export type Value =
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "int"; value: bigint }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "array"; value: Value[] }
  | { kind: "record"; value: Map<string, Value> }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "fn"; params: string[]; body: Expr; env: Env }
  | { kind: "variant"; tag: string; fields: Value[] }
  | { kind: "cap"; id: string; methods: Record<string, (...args: Value[]) => EvalResult> }
  | { kind: "continuation"; resume: (v: Value) => Generator<Effect, EvalResult, Value> };

export const NULL: Value = { kind: "null" };
export const TRUE: Value = { kind: "bool", value: true };
export const FALSE: Value = { kind: "bool", value: false };

export function bool(value: boolean): Value {
  return value ? TRUE : FALSE;
}

/** Structural equality of two values. */
export function valEqual(a: Value, b: Value): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "null":
      return true;
    case "bool":
      return a.value === (b as { kind: "bool"; value: boolean }).value;
    case "int":
      return a.value === (b as { kind: "int"; value: bigint }).value;
    case "float":
      return a.value === (b as { kind: "float"; value: number }).value;
    case "string":
      return a.value === (b as { kind: "string"; value: string }).value;
    case "array": {
      const ba = b as { kind: "array"; value: Value[] };
      if (a.value.length !== ba.value.length) return false;
      for (let i = 0; i < a.value.length; i++) {
        if (!valEqual(a.value[i] as Value, ba.value[i] as Value)) return false;
      }
      return true;
    }
    case "record": {
      const br = b as { kind: "record"; value: Map<string, Value> };
      if (a.value.size !== br.value.size) return false;
      for (const [k, v] of a.value) {
        const bv = br.value.get(k);
        if (bv === undefined || !valEqual(v, bv)) return false;
      }
      return true;
    }
    case "bytes": {
      const bb = b as { kind: "bytes"; value: Uint8Array };
      if (a.value.length !== bb.value.length) return false;
      for (let i = 0; i < a.value.length; i++) {
        if (a.value[i] !== bb.value[i]) return false;
      }
      return true;
    }
    case "fn":
      // Functions are only equal by reference (same closure object)
      return a === b;
    case "variant": {
      const bv = b as { kind: "variant"; tag: string; fields: Value[] };
      if (a.tag !== bv.tag || a.fields.length !== bv.fields.length) return false;
      for (let i = 0; i < a.fields.length; i++) {
        if (!valEqual(a.fields[i] as Value, bv.fields[i] as Value)) return false;
      }
      return true;
    }
    case "cap":
      return a === b;
    case "continuation":
      return a === b;
  }
}

/** Human-readable type name for error messages. */
export function typeName(v: Value): string {
  return v.kind;
}

/** Convert a value to its string representation (for to-string). */
export function valueToString(v: Value): string {
  switch (v.kind) {
    case "null":
      return "null";
    case "bool":
      return v.value ? "true" : "false";
    case "int":
      return v.value.toString();
    case "float":
      return v.value.toString();
    case "string":
      return v.value;
    case "array":
      return `[${v.value.map(valueToString).join(", ")}]`;
    case "record": {
      const entries = [...v.value.entries()].map(([k, val]) => `${k}: ${valueToString(val)}`);
      return `{${entries.join(", ")}}`;
    }
    case "bytes":
      return "<bytes:" + String(v.value.length) + ">";
    case "fn":
      return `<fn(${v.params.join(", ")})>`;
    case "variant":
      if (v.fields.length === 0) return v.tag;
      return `${v.tag}(${v.fields.map(valueToString).join(", ")})`;
    case "cap":
      return `<cap:${v.id}>`;
    case "continuation":
      return "<continuation>";
  }
}
