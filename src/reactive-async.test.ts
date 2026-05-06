import { describe, it, expect } from "bun:test";
import { signal } from "@rhi-zone/rainbow";
import { isSuccess, isFailure, isLoading } from "@rhi-zone/rainbow";
import type { AsyncData } from "@rhi-zone/rainbow";
import type { ReadonlySignal } from "@rhi-zone/rainbow";
import { compileReactive, makeAsyncFnCap } from "./reactive.ts";
import type { Expr } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait until the AsyncData signal value satisfies the predicate.
 * Returns the settled value.
 */
async function waitFor(
  sig: ReadonlySignal<AsyncData<unknown>>,
  pred: (v: AsyncData<unknown>) => boolean,
): Promise<AsyncData<unknown>> {
  const current = sig.get();
  if (pred(current)) return current;
  return new Promise<AsyncData<unknown>>((resolve) => {
    const unsub = sig.subscribe((v) => {
      if (pred(v)) {
        unsub();
        resolve(v);
      }
    });
  });
}

/**
 * Cast the `ReadonlySignal<unknown>` returned by compileReactive to the typed
 * async signal shape. The reactive layer guarantees this when the expr
 * contains an Async effect.
 */
function asAsyncSig(
  out: ReturnType<ReturnType<typeof compileReactive>>,
): ReadonlySignal<AsyncData<unknown>> {
  return out as unknown as ReadonlySignal<AsyncData<unknown>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compileReactive — async effect (perform Async)", () => {
  it("Marinada fn that evaluates to a value: resolves to success", async () => {
    // The fn body returns 42 synchronously; callAsyncFn wraps it in Promise.resolve.
    const expr: Expr = ["perform", "Async", ["fn", ["signal"], 42]];
    const fn = compileReactive(expr);
    const out = asAsyncSig(fn({}));

    const result = await waitFor(out, isSuccess);
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.value).toBe(42n);
    }
  });

  it("native async cap that resolves immediately: resolves to success", async () => {
    const asyncFn = makeAsyncFnCap((_signal) => Promise.resolve("hello"));
    // The cap Value is embedded directly in the Expr; evalGen handles it as an
    // opaque value and returns it, which evaluate sees as the fn payload.
    const expr = ["perform", "Async", asyncFn] as unknown as Expr;
    const fn = compileReactive(expr);
    const out = asAsyncSig(fn({}));

    const result = await waitFor(out, isSuccess);
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.value).toBe("hello");
    }
  });

  it("starts in loading state", () => {
    let resolveP!: (v: unknown) => void;
    const asyncFn = makeAsyncFnCap(
      (_signal) =>
        new Promise((res) => {
          resolveP = res;
        }),
    );
    const expr = ["perform", "Async", asyncFn] as unknown as Expr;
    const fn = compileReactive(expr);
    const out = asAsyncSig(fn({}));

    expect(isLoading(out.get())).toBe(true);
    // Clean up
    resolveP("done");
  });

  it("dep change while in-flight: first request aborted, final state is success from new request", async () => {
    const x = signal<unknown>("first");
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    let callCount = 0;

    const asyncFn = makeAsyncFnCap((_signal) => {
      callCount++;
      if (callCount === 1) {
        return new Promise((res) => {
          resolveFirst = res;
        });
      } else {
        return new Promise((res) => {
          resolveSecond = res;
        });
      }
    });

    // Reference "x" in the expr so depsSignal tracks it; the let binding makes
    // it a free variable without affecting the async result.
    const expr = ["let", [["_dep", "x"]], ["perform", "Async", asyncFn]] as unknown as Expr;
    const fn = compileReactive(expr);
    const out = asAsyncSig(fn({ x }));

    // Initially loading (first call has started)
    expect(isLoading(out.get())).toBe(true);
    expect(callCount).toBe(1);

    // Change dep — triggers cancellation of first, starts second
    x.set("second");
    expect(callCount).toBe(2);

    // Resolve second request
    resolveSecond("from-second");

    const result = await waitFor(out, isSuccess);
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.value).toBe("from-second");
    }

    // Now resolve first (should be discarded because it was aborted)
    resolveFirst("from-first");
    // Give microtasks a chance to run
    await Promise.resolve();
    // State should still be from second
    const finalResult = out.get();
    expect(isSuccess(finalResult)).toBe(true);
    if (isSuccess(finalResult)) {
      expect(finalResult.value).toBe("from-second");
    }
  });

  it("abort signal is actually aborted when dep changes", async () => {
    const x = signal<unknown>(1n);
    let capturedSignal: AbortSignal | null = null;
    let resolveP!: (v: unknown) => void;

    const asyncFn = makeAsyncFnCap((abortSignal) => {
      capturedSignal = abortSignal;
      return new Promise((res) => {
        resolveP = res;
      });
    });

    // Reference "x" in the expr so depsSignal tracks it.
    const expr = ["let", [["_dep", "x"]], ["perform", "Async", asyncFn]] as unknown as Expr;
    const fn = compileReactive(expr);
    fn({ x });

    // Signal should not be aborted yet
    expect(capturedSignal).not.toBe(null);
    expect(capturedSignal!.aborted).toBe(false);

    // Change dep — first controller should be aborted
    const firstSignal = capturedSignal!;
    x.set(2n);

    expect(firstSignal.aborted).toBe(true);

    // Clean up second request
    resolveP("done");
  });

  it("error from Promise: resolves to failure state", async () => {
    const err = new Error("something went wrong");
    const asyncFn = makeAsyncFnCap((_signal) => Promise.reject(err));
    const expr = ["perform", "Async", asyncFn] as unknown as Expr;
    const fn = compileReactive(expr);
    const out = asAsyncSig(fn({}));

    const result = await waitFor(out, (v) => !isLoading(v));
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.error).toBe(err);
    }
  });

  it("dep-based reactive: updates with new dep values on each run", async () => {
    const x = signal<unknown>(10n);

    // The async fn resolves with the current value of x (read from JS closure).
    // Reference "x" in the expr so depsSignal tracks it and re-runs on change.
    const asyncFn = makeAsyncFnCap((_signal) => Promise.resolve(x.get()));
    const expr = ["let", [["_dep", "x"]], ["perform", "Async", asyncFn]] as unknown as Expr;
    const fn = compileReactive(expr);
    const out = asAsyncSig(fn({ x }));

    const first = await waitFor(out, isSuccess);
    expect(isSuccess(first) && first.value).toBe(10n);

    x.set(20n);
    // Signal goes to loading then success
    const second = await waitFor(out, isSuccess);
    expect(isSuccess(second) && second.value).toBe(20n);
  });
});
