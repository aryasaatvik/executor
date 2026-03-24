import type * as Effect from "effect/Effect";

// ---------------------------------------------------------------------------
// Promiseify — recursive mapped type
// ---------------------------------------------------------------------------

/**
 * Recursively converts an Effect-based API to a Promise-based one:
 * - `Effect<A, E, R>` → `Promise<A>`
 * - `(...args) => R`  → `(...args) => Promiseify<R>`
 * - `object`          → `{ [K]: Promiseify<V> }`
 * - everything else   → passthrough
 */
export type Promiseify<T> = T extends Effect.Effect<infer A, any, any>
  ? Promise<A>
  : T extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promiseify<Result>
    : T extends Promise<infer A>
      ? Promise<A>
      : T extends object
        ? { readonly [Key in keyof T]: Promiseify<T[Key]> }
        : T;

// ---------------------------------------------------------------------------
// Runtime wrapper
// ---------------------------------------------------------------------------

type RunEffect = <A>(effect: Effect.Effect<A, any, never>) => Promise<A>;

/**
 * Recursively wraps an Effect-based API object so that every leaf function
 * returning an `Effect` instead returns a `Promise` via the given `run`.
 */
export const wrapEffectApi = <T extends object>(
  api: T,
  run: RunEffect,
): Promiseify<T> => {
  const wrapped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(api)) {
    if (typeof value === "function") {
      wrapped[key] = (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown)(...args);
        // If the result looks like an Effect (has pipe + _op), wrap it.
        if (isEffect(result)) {
          return run(result as Effect.Effect<unknown, unknown, never>);
        }
        return result;
      };
    } else if (value !== null && typeof value === "object") {
      wrapped[key] = wrapEffectApi(value as object, run);
    } else {
      wrapped[key] = value;
    }
  }

  return wrapped as Promiseify<T>;
};

// ---------------------------------------------------------------------------
// Effect duck-typing
// ---------------------------------------------------------------------------

const isEffect = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  "pipe" in (value as object) &&
  "_op" in (value as object);
