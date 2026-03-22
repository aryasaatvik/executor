import { SqlClient } from "@effect/sql";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { searchVec } from "./vec";

describe("searchVec", () => {
  it.effect("passes the requested candidate limit through to sqlite-vec", () =>
    Effect.gen(function* () {
      let capturedParams: ReadonlyArray<unknown> | null = null;

      const result = yield* searchVec({
        queryEmbedding: [0.1, 0.2, 0.3],
        limit: 10,
      }).pipe(
        Effect.provide(
          Layer.succeed(SqlClient.SqlClient, {
            unsafe: (_query: string, params: ReadonlyArray<unknown>) => {
              capturedParams = params;
              return Effect.succeed([]);
            },
          } as never),
        ),
      );

      expect(result).toEqual([]);
      expect(capturedParams?.[1]).toBe(10);
    }),
  );
});
