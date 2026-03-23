import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { SqlClient } from "@effect/sql";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { describe, expect, it } from "@effect/vitest";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";

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
  makeDatabaseLive: () => makeFakeDbLayer(),
  loadSqliteVecExtension: Effect.succeed(false),
}));

vi.mock("../db/setup", () => ({
  makeWorkspaceCatalogDbLayer: () => makeFakeDbLayer(),
  makeWorkspaceCatalogQueryDbLayer: () => makeFakeDbLayer(),
}));

vi.mock("./catalog/source/reconcile", () => ({
  reconcileMissingSourceCatalogArtifacts: () =>
    Effect.fail(new Error("reconcile failed")),
}));

import { createControlPlaneRuntime } from "./index";

describe("control-plane runtime startup", () => {
  it.scoped("surfaces source catalog reconciliation failures", () =>
    Effect.gen(function* () {
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
});
