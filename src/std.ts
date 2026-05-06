import type { Expr, Module } from "./types.ts";

export type StdBinding = {
  name: string;
  expr: Expr;
};

/**
 * lib:std standard library bindings.
 * Defined as ordinary Marinada expressions — no special compiler knowledge.
 * Loaded by the module resolver the same way as any other lib: module.
 */
export const STD_BINDINGS: StdBinding[] = [
  // --- Function combinators ---
  { name: "identity", expr: ["fn", ["x"], "x"] },
  { name: "compose", expr: ["fn", ["f", "g"], ["fn", ["x"], ["call", "f", ["call", "g", "x"]]]] },
  { name: "const", expr: ["fn", ["x"], ["fn", ["_"], "x"]] },
  { name: "flip", expr: ["fn", ["f"], ["fn", ["a", "b"], ["call", "f", "b", "a"]]] },

  // --- Option<T> = None | Some(T) ---
  // Uppercase aliases — importers may list "None", "Some", "Ok", "Err" in
  // their import list; these bindings satisfy UNDEFINED_EXPORT checks while
  // the evaluator also handles them via the uppercase-tag convention.
  { name: "None", expr: ["None"] },
  { name: "Some", expr: ["fn", ["x"], ["Some", "x"]] },
  { name: "some", expr: ["fn", ["x"], ["Some", "x"]] },
  { name: "none", expr: ["None"] },
  {
    name: "is-some",
    expr: ["fn", ["opt"], ["match", "opt", [["Some", "_"], true], [["None"], false]]],
  },
  {
    name: "is-none",
    expr: ["fn", ["opt"], ["match", "opt", [["None"], true], [["Some", "_"], false]]],
  },
  {
    name: "unwrap-or",
    expr: ["fn", ["opt", "default"], ["match", "opt", [["Some", "x"], "x"], [["None"], "default"]]],
  },
  {
    name: "map-option",
    expr: [
      "fn",
      ["f", "opt"],
      [
        "match",
        "opt",
        [
          ["Some", "x"],
          ["Some", ["call", "f", "x"]],
        ],
        [["None"], ["None"]],
      ],
    ],
  },
  {
    name: "and-then",
    expr: [
      "fn",
      ["f", "opt"],
      [
        "match",
        "opt",
        [
          ["Some", "x"],
          ["call", "f", "x"],
        ],
        [["None"], ["None"]],
      ],
    ],
  },
  {
    name: "option-or",
    expr: [
      "fn",
      ["opt", "fallback"],
      [
        "match",
        "opt",
        [
          ["Some", "x"],
          ["Some", "x"],
        ],
        [["None"], "fallback"],
      ],
    ],
  },

  // --- Result<T, E> = Ok(T) | Err(E) ---
  // Uppercase aliases (see Option section above).
  { name: "Ok", expr: ["fn", ["x"], ["Ok", "x"]] },
  { name: "Err", expr: ["fn", ["e"], ["Err", "e"]] },
  { name: "ok", expr: ["fn", ["x"], ["Ok", "x"]] },
  { name: "err", expr: ["fn", ["e"], ["Err", "e"]] },
  {
    name: "is-ok",
    expr: ["fn", ["r"], ["match", "r", [["Ok", "_"], true], [["Err", "_"], false]]],
  },
  {
    name: "is-err",
    expr: ["fn", ["r"], ["match", "r", [["Err", "_"], true], [["Ok", "_"], false]]],
  },
  {
    name: "unwrap-or-else",
    expr: [
      "fn",
      ["r", "f"],
      [
        "match",
        "r",
        [["Ok", "x"], "x"],
        [
          ["Err", "e"],
          ["call", "f", "e"],
        ],
      ],
    ],
  },
  {
    name: "map-result",
    expr: [
      "fn",
      ["f", "r"],
      [
        "match",
        "r",
        [
          ["Ok", "x"],
          ["Ok", ["call", "f", "x"]],
        ],
        [
          ["Err", "e"],
          ["Err", "e"],
        ],
      ],
    ],
  },
  {
    name: "map-err",
    expr: [
      "fn",
      ["f", "r"],
      [
        "match",
        "r",
        [
          ["Ok", "x"],
          ["Ok", "x"],
        ],
        [
          ["Err", "e"],
          ["Err", ["call", "f", "e"]],
        ],
      ],
    ],
  },
  {
    name: "result-and-then",
    expr: [
      "fn",
      ["f", "r"],
      [
        "match",
        "r",
        [
          ["Ok", "x"],
          ["call", "f", "x"],
        ],
        [
          ["Err", "e"],
          ["Err", "e"],
        ],
      ],
    ],
  },

  // --- Numeric helpers ---
  { name: "clamp", expr: ["fn", ["x", "lo", "hi"], ["max", "lo", ["min", "x", "hi"]]] },
  {
    name: "between?",
    expr: ["fn", ["x", "lo", "hi"], ["and", [">=", "x", "lo"], ["<=", "x", "hi"]]],
  },
  // sign: -1, 0, or 1 — uses nested if since cond is not a primitive
  { name: "sign", expr: ["fn", ["x"], ["if", ["<", "x", 0], -1, ["if", [">", "x", 0], 1, 0]]] },

  // --- String helpers ---
  { name: "str-empty?", expr: ["fn", ["s"], ["==", ["str-len", "s"], 0]] },
  { name: "bool->str", expr: ["fn", ["b"], ["to-string", "b"]] },

  // --- Higher-order collection functions ---
  // map: apply f to each element, returning a new array.
  {
    name: "map",
    expr: [
      "letrec",
      [
        [
          "go",
          [
            "fn",
            ["f", "xs", "acc", "i"],
            [
              "if",
              ["==", "i", ["count", "xs"]],
              "acc",
              [
                "call",
                "go",
                "f",
                "xs",
                ["array-push", "acc", ["call", "f", ["array-get", "xs", "i"]]],
                ["+", "i", 1],
              ],
            ],
          ],
        ],
      ],
      ["fn", ["f", "xs"], ["call", "go", "f", "xs", ["array"], 0]],
    ],
  },

  // filter: keep only elements for which f returns true.
  {
    name: "filter",
    expr: [
      "letrec",
      [
        [
          "go",
          [
            "fn",
            ["f", "xs", "acc", "i"],
            [
              "if",
              ["==", "i", ["count", "xs"]],
              "acc",
              [
                "let",
                [["item", ["array-get", "xs", "i"]]],
                [
                  "if",
                  ["call", "f", "item"],
                  ["call", "go", "f", "xs", ["array-push", "acc", "item"], ["+", "i", 1]],
                  ["call", "go", "f", "xs", "acc", ["+", "i", 1]],
                ],
              ],
            ],
          ],
        ],
      ],
      ["fn", ["f", "xs"], ["call", "go", "f", "xs", ["array"], 0]],
    ],
  },

  // reduce: fold array to a single value using f(acc, elem), starting from init.
  {
    name: "reduce",
    expr: [
      "letrec",
      [
        [
          "go",
          [
            "fn",
            ["f", "xs", "acc", "i"],
            [
              "if",
              ["==", "i", ["count", "xs"]],
              "acc",
              [
                "call",
                "go",
                "f",
                "xs",
                ["call", "f", "acc", ["array-get", "xs", "i"]],
                ["+", "i", 1],
              ],
            ],
          ],
        ],
      ],
      ["fn", ["f", "init", "xs"], ["call", "go", "f", "xs", "init", 0]],
    ],
  },

  // find: return first element matching predicate, or null.
  {
    name: "find",
    expr: [
      "letrec",
      [
        [
          "go",
          [
            "fn",
            ["f", "xs", "i"],
            [
              "if",
              ["==", "i", ["count", "xs"]],
              null,
              [
                "if",
                ["call", "f", ["array-get", "xs", "i"]],
                ["array-get", "xs", "i"],
                ["call", "go", "f", "xs", ["+", "i", 1]],
              ],
            ],
          ],
        ],
      ],
      ["fn", ["f", "xs"], ["call", "go", "f", "xs", 0]],
    ],
  },

  // every: true if predicate holds for all elements.
  {
    name: "every",
    expr: [
      "letrec",
      [
        [
          "go",
          [
            "fn",
            ["f", "xs", "i"],
            [
              "if",
              ["==", "i", ["count", "xs"]],
              true,
              [
                "if",
                ["call", "f", ["array-get", "xs", "i"]],
                ["call", "go", "f", "xs", ["+", "i", 1]],
                false,
              ],
            ],
          ],
        ],
      ],
      ["fn", ["f", "xs"], ["call", "go", "f", "xs", 0]],
    ],
  },

  // any: true if predicate holds for at least one element.
  // Named "any" to avoid conflict with the option constructor "some".
  {
    name: "any",
    expr: [
      "letrec",
      [
        [
          "go",
          [
            "fn",
            ["f", "xs", "i"],
            [
              "if",
              ["==", "i", ["count", "xs"]],
              false,
              [
                "if",
                ["call", "f", ["array-get", "xs", "i"]],
                true,
                ["call", "go", "f", "xs", ["+", "i", 1]],
              ],
            ],
          ],
        ],
      ],
      ["fn", ["f", "xs"], ["call", "go", "f", "xs", 0]],
    ],
  },

  // flat-map: map f over xs, then flatten one level.
  // Uses index-based recursion to avoid depending on the reduce std binding.
  {
    name: "flat-map",
    expr: [
      "letrec",
      [
        // append-all: append all elements of src into acc, starting at index i
        [
          "append-all",
          [
            "fn",
            ["src", "acc", "i"],
            [
              "if",
              ["==", "i", ["count", "src"]],
              "acc",
              [
                "call",
                "append-all",
                "src",
                ["array-push", "acc", ["array-get", "src", "i"]],
                ["+", "i", 1],
              ],
            ],
          ],
        ],
        // go: process each element of xs, mapping f then appending results
        [
          "go",
          [
            "fn",
            ["f", "xs", "acc", "i"],
            [
              "if",
              ["==", "i", ["count", "xs"]],
              "acc",
              [
                "call",
                "go",
                "f",
                "xs",
                ["call", "append-all", ["call", "f", ["array-get", "xs", "i"]], "acc", 0],
                ["+", "i", 1],
              ],
            ],
          ],
        ],
      ],
      ["fn", ["f", "xs"], ["call", "go", "f", "xs", ["array"], 0]],
    ],
  },

  // includes: true if value is in array (structural equality).
  {
    name: "includes",
    expr: [
      "letrec",
      [
        [
          "go",
          [
            "fn",
            ["xs", "v", "i"],
            [
              "if",
              ["==", "i", ["count", "xs"]],
              false,
              [
                "if",
                ["==", ["array-get", "xs", "i"], "v"],
                true,
                ["call", "go", "xs", "v", ["+", "i", 1]],
              ],
            ],
          ],
        ],
      ],
      ["fn", ["xs", "v"], ["call", "go", "xs", "v", 0]],
    ],
  },

  // index-of: return index of first occurrence of value, or -1 if not found.
  {
    name: "index-of",
    expr: [
      "letrec",
      [
        [
          "go",
          [
            "fn",
            ["xs", "v", "i"],
            [
              "if",
              ["==", "i", ["count", "xs"]],
              -1,
              [
                "if",
                ["==", ["array-get", "xs", "i"], "v"],
                "i",
                ["call", "go", "xs", "v", ["+", "i", 1]],
              ],
            ],
          ],
        ],
      ],
      ["fn", ["xs", "v"], ["call", "go", "xs", "v", 0]],
    ],
  },
];

export const STD_EXPORT_NAMES: string[] = STD_BINDINGS.map((b) => b.name);

/**
 * lib:std as a Module — resolved by `defaultResolver` the same way as any
 * other module. Exports all STD_BINDINGS via a top-level letrec.
 */
export const STD_MODULE: Module = {
  exports: STD_EXPORT_NAMES,
  main: ["letrec", STD_BINDINGS.map((b) => [b.name, b.expr]), null],
};
