// A Marinada expression is a JSON value.
// Atoms are JSON primitives; calls are arrays [op, ...args].
export type Expr = null | boolean | number | string | Expr[];

// A Marinada module.
export type Module = {
  imports?: Import[];
  types?: TypeDef[];
  exports?: string[];
  main: Expr;
};

export type Import = {
  from: string; // e.g. "lib:std", "local:./foo.json", "https://..."
  import: string[];
};

export type TypeDef = {
  name: string;
  linear?: boolean;
  destructor?: Expr;
  variants: Variant[];
};

export type Variant = {
  tag: string;
  fields?: [string, string][]; // [field-name, type-name]
};
