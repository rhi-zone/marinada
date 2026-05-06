import type { Value } from "./value.ts";

export class Env {
  private readonly bindings: Map<string, Value>;
  private readonly parent: Env | null;

  constructor(bindings: Map<string, Value> = new Map(), parent: Env | null = null) {
    this.bindings = bindings;
    this.parent = parent;
  }

  lookup(name: string): Value | undefined {
    const val = this.bindings.get(name);
    if (val !== undefined) return val;
    return this.parent?.lookup(name);
  }

  extend(bindings: Record<string, Value>): Env {
    return new Env(new Map(Object.entries(bindings)), this);
  }

  /** Mutate a binding in this frame (used for letrec). */
  set(name: string, value: Value): void {
    this.bindings.set(name, value);
  }
}

export const EMPTY_ENV = new Env();
