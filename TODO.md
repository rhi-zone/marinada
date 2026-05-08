# TODO

*Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

## Open

- [ ] **Module-level op declarations** — let modules export named ops that the evaluator dispatches on, so consumers can write `["myOp", arg1, arg2]` directly instead of `["call", "myOp", arg1, arg2]`. **Why:** aspect's effect tuples (`["call", "setKind", "context", "ash"]`) read awkwardly because of the `call` wrapping. **NOT** silent env-op-fallthrough — that creates `with`-style ambiguity (you can't tell at parse time whether `[name, ...]` is a built-in op or an env value). Explicit registration via module exports avoids this. Requires evaluator + JIT changes; investigate how `call.method` already does namespaced dispatch as a reference.

- [ ] **Reactive layer test coverage** — only 12 tests for `compileReactive`. Works for what aspect needs (currently unused) but the reactive code path is the most complex part of the codebase and has the thinnest test coverage. Probably worth expanding when reactive is actually exercised in production.

## Recent context (May 2026)

- Extracted from `dusklight/packages/marinada` into its own repo
- Aspect (`exo-place/aspect`) and Dusklight both consume via `github:rhi-zone/marinada`
- Depends on `@rhi-zone/rainbow@0.2.0-alpha.1` (npm) for the reactive layer
- Added `__lit` op to the evaluator (it was already in the JIT and optimizer) for explicit string literal quoting in expressions
