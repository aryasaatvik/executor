import type { AccountId, Source } from "../../model/index";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type LoadedSourceCatalog,
  type LoadedSourceCatalogToolIndexEntry,
  expandCatalogToolByPath,
  expandCatalogTools,
  loadSourceWithCatalog,
} from "../sources/source-inspection";
import { RuntimeLocalWorkspace } from "../engine/runtime-context";
import { WorkspaceDatabase } from "../engine/workspace-database";
import { SourceStore } from "../sources/source-service";

export type RuntimeSourceCatalogStoreShape = {
  loadWorkspaceSourceCatalogs: (input: {
    workspaceId: Source["workspaceId"];
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<readonly LoadedSourceCatalog[], Error, never>;
  loadSourceWithCatalog: (input: {
    workspaceId: Source["workspaceId"];
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<LoadedSourceCatalog, Error, never>;
  loadWorkspaceSourceCatalogToolIndex: (input: {
    workspaceId: Source["workspaceId"];
    actorAccountId?: AccountId | null;
    includeSchemas: boolean;
  }) => Effect.Effect<readonly LoadedSourceCatalogToolIndexEntry[], Error, never>;
  loadWorkspaceSourceCatalogToolByPath: (input: {
    workspaceId: Source["workspaceId"];
    path: string;
    actorAccountId?: AccountId | null;
    includeSchemas: boolean;
  }) => Effect.Effect<LoadedSourceCatalogToolIndexEntry | null, Error, never>;
};

export class SourceCatalogStore extends Context.Tag(
  "#runtime/SourceCatalogStore",
)<SourceCatalogStore, RuntimeSourceCatalogStoreShape>() {}

const ensureRuntimeCatalogWorkspace = (input: {
  expectedWorkspaceId: Source["workspaceId"];
  runtimeWorkspaceId: Source["workspaceId"];
}) =>
  input.expectedWorkspaceId === input.runtimeWorkspaceId
    ? Effect.void
    : Effect.fail(
        new Error(
          `Runtime local workspace mismatch: expected ${input.expectedWorkspaceId}, got ${input.runtimeWorkspaceId}`,
        ),
      );

const provideCatalogDeps = <A, E, R>(input: {
  effect: Effect.Effect<A, E, R>;
  runtimeLocalWorkspace: Effect.Effect.Success<typeof RuntimeLocalWorkspace>;
  sourceStore: Effect.Effect.Success<typeof SourceStore>;
  workspaceDatabase: Effect.Effect.Success<typeof WorkspaceDatabase>;
}) =>
  input.effect.pipe(
    Effect.provideService(RuntimeLocalWorkspace, input.runtimeLocalWorkspace),
    Effect.provideService(SourceStore, input.sourceStore),
    Effect.provideService(WorkspaceDatabase, input.workspaceDatabase),
  );

const loadWorkspaceCatalogs = (input: {
  workspaceId: Source["workspaceId"];
  actorAccountId?: AccountId | null;
  runtimeLocalWorkspace: Effect.Effect.Success<typeof RuntimeLocalWorkspace>;
  sourceStore: Effect.Effect.Success<typeof SourceStore>;
  workspaceDatabase: Effect.Effect.Success<typeof WorkspaceDatabase>;
}): Effect.Effect<readonly LoadedSourceCatalog[], Error, never> =>
  Effect.gen(function* () {
    yield* ensureRuntimeCatalogWorkspace({
      expectedWorkspaceId: input.workspaceId,
      runtimeWorkspaceId: input.runtimeLocalWorkspace.installation.workspaceId,
    });

    const sources = yield* input.sourceStore.loadSourcesInWorkspace(
      input.workspaceId,
      { actorAccountId: input.actorAccountId },
    );

    const catalogs = yield* Effect.forEach(
      sources,
      (source) =>
        provideCatalogDeps({
          effect: loadSourceWithCatalog({
            workspaceId: input.workspaceId,
            sourceId: source.id,
          }),
          runtimeLocalWorkspace: input.runtimeLocalWorkspace,
          sourceStore: input.sourceStore,
          workspaceDatabase: input.workspaceDatabase,
        }).pipe(
          Effect.map((catalog) => catalog as LoadedSourceCatalog | null),
          Effect.catchAll(() => Effect.succeed(null as LoadedSourceCatalog | null)),
        ),
      { concurrency: 1 },
    );

    return catalogs.filter((catalog): catalog is LoadedSourceCatalog => catalog !== null);
  });

export const RuntimeSourceCatalogStoreLive = Layer.effect(
  SourceCatalogStore,
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspace;
    const sourceStore = yield* SourceStore;
    const workspaceDatabase = yield* WorkspaceDatabase;

    return SourceCatalogStore.of({
      loadWorkspaceSourceCatalogs: (input) =>
        loadWorkspaceCatalogs({
          workspaceId: input.workspaceId,
          actorAccountId: input.actorAccountId,
          runtimeLocalWorkspace,
          sourceStore,
          workspaceDatabase,
        }),
      loadSourceWithCatalog: (input) =>
        ensureRuntimeCatalogWorkspace({
          expectedWorkspaceId: input.workspaceId,
          runtimeWorkspaceId: runtimeLocalWorkspace.installation.workspaceId,
        }).pipe(
          Effect.zipRight(
            provideCatalogDeps({
              effect: loadSourceWithCatalog({
                workspaceId: input.workspaceId,
                sourceId: input.sourceId,
              }),
              runtimeLocalWorkspace,
              sourceStore,
              workspaceDatabase,
            }).pipe(
              Effect.mapError((cause) =>
                cause instanceof Error ? cause : new Error(String(cause)),
              ),
            ),
          ),
        ),
      loadWorkspaceSourceCatalogToolIndex: (input) =>
        loadWorkspaceCatalogs({
          workspaceId: input.workspaceId,
          actorAccountId: input.actorAccountId,
          runtimeLocalWorkspace,
          sourceStore,
          workspaceDatabase,
        }).pipe(
          Effect.flatMap((catalogs) =>
            expandCatalogTools({
              catalogs,
              includeSchemas: input.includeSchemas,
            }),
          ),
        ),
      loadWorkspaceSourceCatalogToolByPath: (input) =>
        loadWorkspaceCatalogs({
          workspaceId: input.workspaceId,
          actorAccountId: input.actorAccountId,
          runtimeLocalWorkspace,
          sourceStore,
          workspaceDatabase,
        }).pipe(
          Effect.flatMap((catalogs) =>
            expandCatalogToolByPath({
              catalogs,
              path: input.path,
              includeSchemas: input.includeSchemas,
            }),
          ),
        ),
    });
  }),
);
