import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { SqlClient } from "@effect/sql";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { describe, expect, it } from "@effect/vitest";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";

import { WorkspaceDatabase } from "./local/workspace-database";

const makeFakeSql = () =>
  Object.assign(
    (_strings: TemplateStringsArray, ..._values: ReadonlyArray<unknown>) =>
      Effect.void,
    {
      unsafe: (..._args: unknown[]) => Effect.succeed([]),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    },
  );

const makeFakeDbLayer = () =>
  Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, makeFakeSql() as never),
    Layer.succeed(SqliteDrizzle, {} as never),
  );

vi.mock("../db/client", () => ({
  EXECUTOR_DB_FILENAME: "executor.db",
  makeDatabaseLive: () => makeFakeDbLayer(),
  loadSqliteVecExtension: Effect.succeed(false),
}));

vi.mock("../db/setup", () => ({
  makeWorkspaceCatalogDbLayer: () => makeFakeDbLayer(),
  makeWorkspaceCatalogQueryDbLayer: () => makeFakeDbLayer(),
}));

const { reconcileMissingSourceCatalogArtifacts } = vi.hoisted(() => ({
  reconcileMissingSourceCatalogArtifacts: vi.fn(),
}));

vi.mock("./catalog/source/reconcile", () => ({
  reconcileMissingSourceCatalogArtifacts,
}));

import { createControlPlaneRuntime } from "./index";

describe("control-plane runtime startup", () => {
  it.scoped("surfaces source catalog reconciliation failures", () =>
    Effect.gen(function* () {
      reconcileMissingSourceCatalogArtifacts.mockImplementation(() =>
        Effect.fail(new Error("reconcile failed")),
      );
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "executor-runtime-startup-reconcile-",
      });
      const homeConfigPath = join(workspaceRoot, ".executor-home.jsonc");
      const homeStateDirectory = join(workspaceRoot, ".executor-home-state");

      const error = yield* Effect.flip(
        createControlPlaneRuntime({
          workspaceRoot,
          homeConfigPath,
          homeStateDirectory,
        }),
      );

      expect(error.message).toContain("reconcile failed");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped("provides WorkspaceDatabase to startup reconciliation", () =>
    Effect.gen(function* () {
      reconcileMissingSourceCatalogArtifacts.mockImplementation(() =>
        Effect.gen(function* () {
          const workspaceDatabase = yield* WorkspaceDatabase;
          expect(workspaceDatabase.path).toContain("executor.db");
        }),
      );
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "executor-runtime-startup-reconcile-db-",
      });
      const homeConfigPath = join(workspaceRoot, ".executor-home.jsonc");
      const homeStateDirectory = join(workspaceRoot, ".executor-home-state");

      const runtime = yield* Effect.acquireRelease(
        createControlPlaneRuntime({
          workspaceRoot,
          homeConfigPath,
          homeStateDirectory,
        }),
        (createdRuntime) => Effect.promise(() => createdRuntime.close()).pipe(Effect.orDie),
      );

      expect(runtime.localInstallation.workspaceId).toBeDefined();
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
