import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { SqlClient } from "@effect/sql";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateJsonToSqlite } from "./migrate-json";

const makeContext = (): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectory({
      directory: tmpdir(),
      prefix: "executor-json-migration-",
    }).pipe(Effect.orDie);
  });

const makeSqlTag = () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Effect.succeed([]),
        }),
      }),
    }),
  };
  const sql = Object.assign(
    (_strings: TemplateStringsArray, ..._values: ReadonlyArray<unknown>) =>
      Effect.succeed([] as Array<{ value: string }>),
    {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    },
  );

  return Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, sql as never),
    Layer.succeed(SqliteDrizzle, db as never),
  );
};

describe("migrateJsonToSqlite", () => {
  it.effect("succeeds when the JSON files are absent", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeContext();

      yield* migrateJsonToSqlite({
        controlPlaneStatePath: join(workspaceRoot, "control-plane-state.json"),
        workspaceStatePath: join(workspaceRoot, "workspace-state.json"),
      }).pipe(
        Effect.provide(makeSqlTag()),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("succeeds when artifacts directory does not exist", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeContext();

      yield* migrateJsonToSqlite({
        controlPlaneStatePath: join(workspaceRoot, "control-plane-state.json"),
        workspaceStatePath: join(workspaceRoot, "workspace-state.json"),
        artifactsDirectory: join(workspaceRoot, "nonexistent-artifacts"),
      }).pipe(
        Effect.provide(makeSqlTag()),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("succeeds when artifacts directory is empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* makeContext();
      const artifactsDir = join(workspaceRoot, "artifacts");
      const sourcesDir = join(artifactsDir, "sources");
      yield* fs.makeDirectory(sourcesDir, { recursive: true });

      yield* migrateJsonToSqlite({
        controlPlaneStatePath: join(workspaceRoot, "control-plane-state.json"),
        workspaceStatePath: join(workspaceRoot, "workspace-state.json"),
        artifactsDirectory: artifactsDir,
      }).pipe(
        Effect.provide(makeSqlTag()),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("fails when workspace-state policies cannot be migrated losslessly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* makeContext();
      const controlPlaneStatePath = join(workspaceRoot, "control-plane-state.json");
      const workspaceStatePath = join(workspaceRoot, "workspace-state.json");

      yield* fs.writeFileString(
        workspaceStatePath,
        `${JSON.stringify({
          version: 1,
          sources: {},
          policies: {
            policy_a: {
              id: "pol_1",
              createdAt: 1,
              updatedAt: 2,
            },
          },
        })}\n`,
      );

      const error = yield* Effect.flip(
        migrateJsonToSqlite({
          controlPlaneStatePath,
          workspaceStatePath,
        }).pipe(
          Effect.provide(makeSqlTag()),
        ),
      );

      expect(error.message).toContain(
        "workspace-state.json policies cannot be migrated into SQLite without losing data",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("fails when workspace-state source status cannot be attached to an existing source row", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* makeContext();
      const controlPlaneStatePath = join(workspaceRoot, "control-plane-state.json");
      const workspaceStatePath = join(workspaceRoot, "workspace-state.json");

      yield* fs.writeFileString(
        workspaceStatePath,
        `${JSON.stringify({
          version: 1,
          sources: {
            github: {
              status: "draft",
              lastError: null,
              sourceHash: "hash-github",
              createdAt: 1,
              updatedAt: 2,
            },
          },
          policies: {},
        })}\n`,
      );

      const error = yield* Effect.flip(
        migrateJsonToSqlite({
          controlPlaneStatePath,
          workspaceStatePath,
        }).pipe(
          Effect.provide(makeSqlTag()),
        ),
      );

      expect(error.message).toContain(
        "workspace-state.json contains source state for github, but no source row exists to receive it",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
