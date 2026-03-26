import { EXECUTOR_DB_FILENAME } from "../db/client";
import {
  makeWorkspaceCatalogDbLayer,
  makeWorkspaceCatalogQueryDbLayer,
} from "../db/setup";
import { VecService } from "../db/vec";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { SqlClient } from "@effect/sql";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { join } from "node:path";

import {
  RuntimeLocalWorkspace,
  type RuntimeLocalWorkspaceState,
} from "../config/runtime-context";

type WorkspaceDatabaseWriteOptions = Parameters<typeof makeWorkspaceCatalogDbLayer>[1];
type WorkspaceDatabaseQueryOptions = Parameters<typeof makeWorkspaceCatalogQueryDbLayer>[1];

export type WorkspaceDatabaseShape = {
  path: string;
  writeLayer: (
    options?: WorkspaceDatabaseWriteOptions,
  ) => ReturnType<typeof makeWorkspaceCatalogDbLayer>;
  queryLayer: (
    options?: WorkspaceDatabaseQueryOptions,
  ) => ReturnType<typeof makeWorkspaceCatalogQueryDbLayer>;
  provideWrite: <A, E>(
    effect: Effect.Effect<A, E, SqliteDrizzle | SqlClient.SqlClient | VecService>,
    options?: WorkspaceDatabaseWriteOptions,
  ) => Effect.Effect<A, unknown, never>;
  provideQuery: <A, E>(
    effect: Effect.Effect<A, E, SqliteDrizzle | SqlClient.SqlClient | VecService>,
    options?: WorkspaceDatabaseQueryOptions,
  ) => Effect.Effect<A, unknown, never>;
};

export class WorkspaceDatabase extends Context.Tag(
  "#runtime/WorkspaceDatabase",
)<WorkspaceDatabase, WorkspaceDatabaseShape>() {}

export const workspaceDatabasePath = (
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState,
): string =>
  join(
    runtimeLocalWorkspace.context.stateDirectory,
    EXECUTOR_DB_FILENAME,
  );

export const makeWorkspaceDatabase = (
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState,
): WorkspaceDatabaseShape => {
  const path = workspaceDatabasePath(runtimeLocalWorkspace);

  return {
    path,
    writeLayer: (options) => makeWorkspaceCatalogDbLayer(path, options),
    queryLayer: (options) => makeWorkspaceCatalogQueryDbLayer(path, options),
    provideWrite: (effect, options) =>
      effect.pipe(Effect.provide(makeWorkspaceCatalogDbLayer(path, options))),
    provideQuery: (effect, options) =>
      effect.pipe(Effect.provide(makeWorkspaceCatalogQueryDbLayer(path, options))),
  };
};

export const WorkspaceDatabaseLive = Layer.effect(
  WorkspaceDatabase,
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspace;
    return WorkspaceDatabase.of(makeWorkspaceDatabase(runtimeLocalWorkspace));
  }),
);
