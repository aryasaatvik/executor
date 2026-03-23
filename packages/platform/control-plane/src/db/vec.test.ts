import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { SqlClient } from "@effect/sql";
import { describe, expect, it } from "@effect/vitest";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";

import {
  makeWorkspaceCatalogDbLayer,
  makeWorkspaceCatalogQueryDbLayer,
} from "./setup";
import { searchVec } from "./vec";

vi.mock("./client", () => {
  const fakeSql = Object.assign(
    (strings: TemplateStringsArray, ..._values: ReadonlyArray<unknown>) =>
      Effect.void,
    {
      unsafe: () => Effect.succeed([]),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    },
  );

  return {
    makeDatabaseLive: () => Layer.succeed(SqlClient.SqlClient, fakeSql as never),
    loadSqliteVecExtension: Effect.succeed(false),
  };
});

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

describe("workspace catalog sqlite-vec setup", () => {
  it.scoped("fails explicitly when embeddings are configured but sqlite-vec cannot load", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "executor-workspace-vec-required-",
      });
      const dbPath = join(workspaceRoot, "catalog.db");
      let loadCalls = 0;
      const loadSqliteVecExtension = Effect.gen(function* () {
        loadCalls += 1;
        return false;
      });

      const error = yield* Effect.flip(
        Effect.succeed(undefined).pipe(
          Effect.provide(
            makeWorkspaceCatalogDbLayer(dbPath, {
              embeddingDimensions: 8,
              loadSqliteVecExtension,
            }),
          ),
        ),
      );

      expect(loadCalls).toBe(1);
      expect(error.message).toContain("sqlite-vec is required for sqlite-backed semantic search");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("fails explicitly when embeddings are configured in the query layer but sqlite-vec cannot load", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "executor-workspace-vec-query-required-",
      });
      const dbPath = join(workspaceRoot, "catalog.db");
      let loadCalls = 0;
      const loadSqliteVecExtension = Effect.gen(function* () {
        loadCalls += 1;
        return false;
      });

      const error = yield* Effect.flip(
        Effect.succeed(undefined).pipe(
          Effect.provide(
            makeWorkspaceCatalogQueryDbLayer(dbPath, {
              embeddingDimensions: 8,
              loadSqliteVecExtension,
            }),
          ),
        ),
      );

      expect(loadCalls).toBe(1);
      expect(error.message).toContain("sqlite-vec is required for the workspace catalog query layer");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("keeps sqlite-vec optional when embeddings are not configured", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "executor-workspace-vec-optional-",
      });
      const dbPath = join(workspaceRoot, "catalog.db");
      let loadCalls = 0;
      const loadSqliteVecExtension = Effect.gen(function* () {
        loadCalls += 1;
        return false;
      });

      yield* Effect.succeed(undefined).pipe(
        Effect.provide(
          makeWorkspaceCatalogQueryDbLayer(dbPath, {
            loadSqliteVecExtension,
          }),
        ),
      );

      expect(loadCalls).toBe(0);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
