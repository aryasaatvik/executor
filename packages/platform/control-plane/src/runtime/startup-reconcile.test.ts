import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { SqlClient } from "@effect/sql";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { describe, expect, it } from "@effect/vitest";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";

vi.mock("../db/client", () => {
  const fakeSql = Object.assign(
    (strings: TemplateStringsArray, ..._values: ReadonlyArray<unknown>) =>
      Effect.void,
    {
      unsafe: () => Effect.succeed([]),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    },
  );

  return {
    makeDatabaseLive: () =>
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, fakeSql as never),
        Layer.succeed(SqliteDrizzle, {} as never),
      ),
    loadSqliteVecExtension: Effect.succeed(false),
  };
});

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
          dependencies: {
            reconcileMissingSourceCatalogArtifacts: () =>
              Effect.fail(new Error("reconcile failed")),
          },
        }),
      );

      expect(error.message).toContain("reconcile failed");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
