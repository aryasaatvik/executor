import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import type { VectorizeMatch, VectorizeStore, VectorizeVectorInput } from "./vectorize";
import { withCloudflareLimits } from "./store-cloudflare-limits";

// ---------------------------------------------------------------------------
// Inline fake VectorizeStore — records every call it receives so assertions
// can inspect exactly what the decorator forwarded (or withheld).
// ---------------------------------------------------------------------------

interface FakeStoreState {
  upsertCalls: ReadonlyArray<readonly VectorizeVectorInput[]>;
  queryCalls: ReadonlyArray<{ vector: readonly number[]; namespace: string; topK: number }>;
  deleteByIdsCalls: ReadonlyArray<readonly string[]>;
}

const makeFakeStore = (): { store: VectorizeStore; state: FakeStoreState } => {
  const state: FakeStoreState = {
    upsertCalls: [],
    queryCalls: [],
    deleteByIdsCalls: [],
  };
  const store: VectorizeStore = {
    upsert: (vectors) =>
      Effect.sync(() => {
        // @ts-expect-error -- mutating a readonly array tracked for assertions
        state.upsertCalls.push(vectors);
      }),
    query: (input) =>
      Effect.sync(() => {
        // @ts-expect-error -- mutating a readonly array tracked for assertions
        state.queryCalls.push(input);
        return [] as readonly VectorizeMatch[];
      }),
    deleteByIds: (ids) =>
      Effect.sync(() => {
        // @ts-expect-error -- mutating a readonly array tracked for assertions
        state.deleteByIdsCalls.push(ids);
      }),
  };
  return { store, state };
};

/** Build a string whose UTF-8 byte length is exactly `n` bytes (ASCII). */
const asciiId = (n: number): string => "x".repeat(n);

describe("withCloudflareLimits", () => {
  describe("upsert — id byte-length guard", () => {
    it.effect("rejects a vector whose id is 65 bytes (one over the limit)", () =>
      Effect.gen(function* () {
        const { store, state } = makeFakeStore();
        const wrapped = withCloudflareLimits(store);
        const id = asciiId(65); // 65 ASCII chars = 65 UTF-8 bytes
        expect(Buffer.byteLength(id, "utf8")).toBe(65);

        const exit = yield* wrapped.upsert([{ id, values: [1, 0, 0] }]).pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        // Inner store must NOT have been called.
        expect(state.upsertCalls).toHaveLength(0);
      }),
    );

    it.effect("passes through a vector whose id is exactly 64 bytes", () =>
      Effect.gen(function* () {
        const { store, state } = makeFakeStore();
        const wrapped = withCloudflareLimits(store);
        const id = asciiId(64); // exactly at the limit — must pass
        expect(Buffer.byteLength(id, "utf8")).toBe(64);

        const exit = yield* wrapped.upsert([{ id, values: [1, 0, 0] }]).pipe(Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
        // Inner store must have received the call.
        expect(state.upsertCalls).toHaveLength(1);
        expect(state.upsertCalls[0]![0]!.id).toBe(id);
      }),
    );

    it.effect("fails on ANY offending id, even when earlier ids are valid", () =>
      Effect.gen(function* () {
        const { store, state } = makeFakeStore();
        const wrapped = withCloudflareLimits(store);

        const exit = yield* wrapped
          .upsert([
            { id: asciiId(10), values: [1, 0, 0] }, // valid
            { id: asciiId(65), values: [0, 1, 0] }, // over limit
          ])
          .pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(state.upsertCalls).toHaveLength(0);
      }),
    );
  });

  describe("query — topK cap guard", () => {
    it.effect("rejects topK = 21 (one over the metadata-all cap)", () =>
      Effect.gen(function* () {
        const { store, state } = makeFakeStore();
        const wrapped = withCloudflareLimits(store);

        const exit = yield* wrapped
          .query({ vector: [1, 0, 0], namespace: "default", topK: 21 })
          .pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(state.queryCalls).toHaveLength(0);
      }),
    );

    it.effect("delegates topK = 20 (exactly at the cap) to the inner store", () =>
      Effect.gen(function* () {
        const { store, state } = makeFakeStore();
        const wrapped = withCloudflareLimits(store);

        const exit = yield* wrapped
          .query({ vector: [1, 0, 0], namespace: "default", topK: 20 })
          .pipe(Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(state.queryCalls).toHaveLength(1);
        expect(state.queryCalls[0]!.topK).toBe(20);
      }),
    );
  });

  describe("deleteByIds — passes through unchanged", () => {
    it.effect("forwards deleteByIds directly to the inner store", () =>
      Effect.gen(function* () {
        const { store, state } = makeFakeStore();
        const wrapped = withCloudflareLimits(store);

        yield* wrapped.deleteByIds(["id-a", "id-b"]);

        expect(state.deleteByIdsCalls).toHaveLength(1);
        expect(state.deleteByIdsCalls[0]).toEqual(["id-a", "id-b"]);
      }),
    );
  });
});
