// WorkspaceDatabase — copied from @executor/engine/src/runtime/local/workspace-database.ts
import type { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { RuntimeLocalWorkspaceState } from "./runtime-context";

export type WorkspaceDatabaseShape = {
  path: string;
  writeLayer: (options?: unknown) => import("effect/Layer").Layer<any, unknown>;
  queryLayer: (options?: unknown) => import("effect/Layer").Layer<any, unknown>;
  provideWrite: <A, E>(
    effect: Effect.Effect<A, E, SqliteDrizzle>,
    options?: unknown,
  ) => Effect.Effect<A, unknown, never>;
  provideQuery: <A, E>(
    effect: Effect.Effect<A, E, SqliteDrizzle>,
    options?: unknown,
  ) => Effect.Effect<A, unknown, never>;
};

export class WorkspaceDatabase extends Context.Tag(
  "#runtime/WorkspaceDatabase",
)<WorkspaceDatabase, WorkspaceDatabaseShape>() {}

export const makeWorkspaceDatabase = (
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState,
): WorkspaceDatabaseShape => {
  // This is a stub — the real implementation lives in engine and creates
  // SQLite connections via Drizzle. Control-plane receives it via Layer.
  void runtimeLocalWorkspace;
  throw new Error(
    "makeWorkspaceDatabase: use engine runtime provider",
  );
};
