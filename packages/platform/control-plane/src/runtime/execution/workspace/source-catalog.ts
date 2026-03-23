import type {
  ToolCatalog,
} from "@executor/codemode-core";
import type { AccountId, Source, SourceId } from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import {
  SourceCatalogStore,
  type LoadedSourceCatalogToolIndexEntry,
} from "../../catalog/source/runtime";
import type { RuntimeLocalWorkspaceState } from "../../local/runtime-context";
import {
  type WorkspaceConfigStoreShape,
} from "../../local/storage";
import { provideRuntimeLocalWorkspace } from "./local";
import {
  SqliteToolCatalogLive,
  SqliteToolCatalogService,
} from "../../../db/catalog";
import {
  makeWorkspaceCatalogDbLayer,
  makeWorkspaceCatalogQueryDbLayer,
} from "../../../db/setup";
import {
  indexSource,
  removeSourceTools,
  loadToolForInvocation,
  type DbLoadedToolData,
} from "../../../db/indexer";
import type { SourceToIndex, ToolToIndex } from "../../../db/indexer";
import { loadSemanticSearchSignature, writeSemanticSearchSignature } from "../../../db/indexer";
import { syncSourceLifecycle } from "../../../db/source-state";
import {
  workspaceCatalogIndexSignature,
} from "../../programs/execution/semantic-search";
import {
  SourceStore,
} from "../../sources/source-store";
import {
  stableSourceCatalogId,
  stableSourceCatalogRevisionId,
} from "../../sources/source-definitions";
import type { Embedder } from "../../../db/embedder";
import { embedSourceTools, removeSourceEmbeddings } from "../../../db/embed-indexer";
import { catalog_tool } from "../../../db/schema";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import {
  makeWorkspaceDatabase,
  type WorkspaceDatabaseShape,
} from "../../local/workspace-database";

type SourceCatalogDependencies = {
  workspaceDatabase?: WorkspaceDatabaseShape;
  makeSqliteToolCatalogLive?: typeof SqliteToolCatalogLive;
  makeWorkspaceCatalogDbLayer?: typeof makeWorkspaceCatalogDbLayer;
  makeWorkspaceCatalogQueryDbLayer?: typeof makeWorkspaceCatalogQueryDbLayer;
  indexSource?: typeof indexSource;
  removeSourceTools?: typeof removeSourceTools;
  syncSourceLifecycle?: typeof syncSourceLifecycle;
  embedSourceTools?: typeof embedSourceTools;
  removeSourceEmbeddings?: typeof removeSourceEmbeddings;
};

const defaultSourceCatalogDependencies: Required<Omit<SourceCatalogDependencies, "workspaceDatabase">> = {
  makeSqliteToolCatalogLive: SqliteToolCatalogLive,
  makeWorkspaceCatalogDbLayer,
  makeWorkspaceCatalogQueryDbLayer,
  indexSource,
  removeSourceTools,
  syncSourceLifecycle,
  embedSourceTools,
  removeSourceEmbeddings,
};

// ---------------------------------------------------------------------------
const resolveWorkspaceDatabase = (input: {
  dependencies: SourceCatalogDependencies;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
}): WorkspaceDatabaseShape | null => {
  if (input.dependencies.workspaceDatabase) {
    return input.dependencies.workspaceDatabase;
  }

  if (!input.runtimeLocalWorkspace) {
    return null;
  }

  const fallbackDatabase = makeWorkspaceDatabase(input.runtimeLocalWorkspace);

  return {
    ...fallbackDatabase,
    writeLayer: (options) =>
      input.dependencies.makeWorkspaceCatalogDbLayer
        ? input.dependencies.makeWorkspaceCatalogDbLayer(
            fallbackDatabase.path,
            options,
          )
        : fallbackDatabase.writeLayer(options),
    queryLayer: (options) =>
      input.dependencies.makeWorkspaceCatalogQueryDbLayer
        ? input.dependencies.makeWorkspaceCatalogQueryDbLayer(
            fallbackDatabase.path,
            options,
          )
        : fallbackDatabase.queryLayer(options),
    provideWrite: (effect, options) =>
      effect.pipe(
        Effect.provide(
          input.dependencies.makeWorkspaceCatalogDbLayer
            ? input.dependencies.makeWorkspaceCatalogDbLayer(
                fallbackDatabase.path,
                options,
              )
            : fallbackDatabase.writeLayer(options),
        ),
      ),
    provideQuery: (effect, options) =>
      effect.pipe(
        Effect.provide(
          input.dependencies.makeWorkspaceCatalogQueryDbLayer
            ? input.dependencies.makeWorkspaceCatalogQueryDbLayer(
                fallbackDatabase.path,
                options,
              )
            : fallbackDatabase.queryLayer(options),
        ),
      ),
  };
};

// ---------------------------------------------------------------------------
// Tool conversion: LoadedSourceCatalogToolIndexEntry -> ToolToIndex
// ---------------------------------------------------------------------------

export const toToolToIndex = (
  tool: LoadedSourceCatalogToolIndexEntry,
): ToolToIndex => ({
  toolId: tool.path,
  path: tool.path,
  sourceId: tool.source.id,
  sourceKey: tool.descriptor.sourceKey,
  namespace: tool.searchNamespace,
  searchText: tool.searchText,
  title: tool.capability.surface.title ?? undefined,
  description:
    tool.capability.surface.summary
    ?? tool.capability.surface.description
    ?? undefined,
  inputSchemaJson: tool.descriptor.contract?.inputSchema ?? undefined,
  outputSchemaJson: tool.descriptor.contract?.outputSchema ?? undefined,
  inputTypePreview: tool.descriptor.contract?.inputTypePreview ?? undefined,
  outputTypePreview: tool.descriptor.contract?.outputTypePreview ?? undefined,
  interaction: tool.descriptor.interaction ?? "auto",
  providerKind: tool.descriptor.providerKind ?? undefined,
  capabilityJson: JSON.stringify(tool.capability),
  executableJson: JSON.stringify(tool.executable),
});

export const toSourceToIndex = (
  source: LoadedSourceCatalogToolIndexEntry["source"],
): SourceToIndex => ({
  sourceId: source.id,
  workspaceId: source.workspaceId,
  name: source.name,
  kind: source.kind,
  endpoint: source.endpoint,
  status: source.status,
  enabled: source.enabled,
  namespace: source.namespace,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});

export type ManagedWorkspaceSourceCatalog = {
  catalog: ToolCatalog;
  close: Effect.Effect<void, never, never>;
};

// ---------------------------------------------------------------------------
// Existing helper: load tools from JSON artifacts (kept for indexing + invocation)
// ---------------------------------------------------------------------------

export const loadWorkspaceCatalogTools = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof SourceCatalogStore>;
  includeSchemas: boolean;
}): Effect.Effect<
  readonly LoadedSourceCatalogToolIndexEntry[],
  Error,
  never
> =>
  Effect.map(
    input.sourceCatalogStore.loadWorkspaceSourceCatalogToolIndex({
      workspaceId: input.workspaceId,
      actorAccountId: input.accountId,
      includeSchemas: input.includeSchemas,
    }),
    (tools) =>
      tools.filter(
        (tool) => tool.source.enabled && tool.source.status === "connected",
      ),
  );

export const loadWorkspaceCatalogToolByPath = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof SourceCatalogStore>;
  path: string;
  includeSchemas: boolean;
}): Effect.Effect<
  LoadedSourceCatalogToolIndexEntry | null,
  Error,
  never
> =>
  input.sourceCatalogStore.loadWorkspaceSourceCatalogToolByPath({
    workspaceId: input.workspaceId,
    path: input.path,
    actorAccountId: input.accountId,
    includeSchemas: input.includeSchemas,
  }).pipe(
    Effect.map((tool) =>
      tool && tool.source.enabled && tool.source.status === "connected"
        ? tool
        : null,
    ),
  );

// ---------------------------------------------------------------------------
// DB-backed tool loading for invocation
// ---------------------------------------------------------------------------

/**
 * Build a StoredSourceRecord from a full Source object.
 * Used when constructing a LoadedSourceCatalogToolIndexEntry from DB data.
 */
const sourceRecordFromSource = (src: Source): LoadedSourceCatalogToolIndexEntry["sourceRecord"] => ({
  id: src.id,
  workspaceId: src.workspaceId,
  catalogId: stableSourceCatalogId(src),
  catalogRevisionId: stableSourceCatalogRevisionId(src),
  name: src.name,
  kind: src.kind,
  endpoint: src.endpoint,
  status: src.status,
  enabled: src.enabled,
  namespace: src.namespace,
  iconUrl: src.iconUrl,
  importAuthPolicy: src.importAuthPolicy,
  bindingConfigJson: JSON.stringify(src.binding),
  sourceHash: src.sourceHash,
  lastError: src.lastError,
  createdAt: src.createdAt,
  updatedAt: src.updatedAt,
});

/**
 * Load a tool by path from SQLite for invocation. Queries catalog_tool for
 * capability_json + executable_json and catalog_revision for snapshot_json,
 * then loads the full Source from the source store.
 *
 * Returns a LoadedSourceCatalogToolIndexEntry compatible with the existing
 * invocation pipeline, or null if the tool is not found or not available.
 */
export const loadWorkspaceCatalogToolByPathFromDb = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  path: string;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  sourceStore: Effect.Effect.Success<typeof SourceStore>;
}): Effect.Effect<LoadedSourceCatalogToolIndexEntry | null, unknown> => {
  const workspaceDatabase = resolveWorkspaceDatabase({
    dependencies: defaultSourceCatalogDependencies,
    runtimeLocalWorkspace: input.runtimeLocalWorkspace,
  });

  if (!workspaceDatabase) {
    return Effect.succeed(null);
  }

  return Effect.gen(function* () {
    const toolData = yield* workspaceDatabase.provideQuery(
      loadToolForInvocation(input.path),
    );

    if (!toolData) return null;

    // Load the full Source object from the source store (handles binding, auth, etc.)
    const src = yield* input.sourceStore.loadSourceById({
      workspaceId: input.workspaceId,
      sourceId: toolData.sourceId,
      actorAccountId: input.accountId,
    });

    if (!src.enabled || src.status !== "connected") return null;

    const searchNamespace = toolData.namespace;
    const searchText = [
      toolData.path,
      searchNamespace,
      src.name,
      toolData.capability.surface.title,
      toolData.capability.surface.summary,
      toolData.capability.surface.description,
    ]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ")
      .toLowerCase();

    return {
      path: toolData.path,
      searchNamespace,
      searchText,
      source: src,
      sourceRecord: sourceRecordFromSource(src),
      capabilityId: toolData.capability.id,
      executableId: toolData.executable.id,
      capability: toolData.capability,
      executable: toolData.executable,
      descriptor: toolData.descriptor,
      projectedCatalog: toolData.catalog,
    } as LoadedSourceCatalogToolIndexEntry;
  });
};

// ---------------------------------------------------------------------------
// Index workspace tools into SQLite
// ---------------------------------------------------------------------------

/**
 * Load all tools from the JSON artifact store and index them into
 * the SQLite catalog. Called during workspace environment setup to
 * ensure the DB is populated before queries hit it.
 */
export const indexWorkspaceToolsIntoSqlite = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof SourceCatalogStore>;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  embedder?: Embedder;
  dependencies?: SourceCatalogDependencies;
}): Effect.Effect<void, unknown, never> => {
  const dependencies = {
    ...defaultSourceCatalogDependencies,
    ...input.dependencies,
  };
  const workspaceDatabase = resolveWorkspaceDatabase({
    dependencies,
    runtimeLocalWorkspace: input.runtimeLocalWorkspace,
  });
  if (!workspaceDatabase) {
    return Effect.fail(new Error("Workspace catalog DB path is unavailable."));
  }

  return workspaceDatabase.provideWrite(
    input.sourceCatalogStore.loadWorkspaceSourceCatalogToolIndex({
      workspaceId: input.workspaceId,
      actorAccountId: input.accountId,
      includeSchemas: true,
    }).pipe(
      Effect.flatMap((allTools) => {
        const activeSourceIds = new Set<SourceId>();
        const nextSemanticSearchSignature = workspaceCatalogIndexSignature({
          embedder: input.embedder,
        });

        // Group tools by source for indexing
        const toolsBySource = new Map<SourceId, {
          sourceId: SourceId;
          sourceKey: string;
          source: SourceToIndex;
          tools: ToolToIndex[];
        }>();

        for (const tool of allTools) {
          const sourceId = tool.source.id;
          activeSourceIds.add(sourceId);
          if (!toolsBySource.has(sourceId)) {
            toolsBySource.set(sourceId, {
              sourceId,
              sourceKey: tool.descriptor.sourceKey,
              source: toSourceToIndex(tool.source),
              tools: [],
            });
          }
          if (tool.source.enabled && tool.source.status === "connected") {
            toolsBySource.get(sourceId)!.tools.push(toToolToIndex(tool));
          }
        }

        return Effect.gen(function* () {
          const db = yield* SqliteDrizzle;
          const previousSemanticSearchSignature = yield* loadSemanticSearchSignature(
            input.workspaceId,
          ).pipe(Effect.catchAll(() => Effect.succeed(null)));
          const shouldRebuildEmbeddings =
            previousSemanticSearchSignature !== nextSemanticSearchSignature;
          const indexedSources = yield* db
            .selectDistinct({
              sourceId: catalog_tool.sourceId,
              sourceKey: catalog_tool.sourceKey,
            })
            .from(catalog_tool);

          for (const indexedSource of indexedSources) {
            if (activeSourceIds.has(indexedSource.sourceId)) {
              continue;
            }

            yield* dependencies.removeSourceTools(indexedSource.sourceId);
            yield* dependencies.removeSourceEmbeddings(indexedSource.sourceKey);
          }

          yield* Effect.forEach(
            [...toolsBySource.values()],
            (group) =>
              Effect.gen(function* () {
                if (!group.source.enabled || group.source.status !== "connected") {
                  yield* dependencies.syncSourceLifecycle({
                    sourceId: group.sourceId,
                    source: group.source,
                  });
                  return;
                }

                const result = yield* dependencies.indexSource({
                  sourceId: group.sourceId,
                  sourceKey: group.sourceKey,
                  source: group.source,
                  tools: group.tools,
                });

                const toolsToEmbed = shouldRebuildEmbeddings
                  ? group.tools
                  : result.changedTools;

                if (input.embedder && toolsToEmbed.length > 0) {
                  yield* dependencies.embedSourceTools({
                    embedder: input.embedder,
                    tools: toolsToEmbed,
                    sourceKey: group.sourceKey,
                  });
                }
              }),
            { concurrency: 1 },
          );

          if (previousSemanticSearchSignature !== nextSemanticSearchSignature) {
            yield* writeSemanticSearchSignature(
              input.workspaceId,
              nextSemanticSearchSignature,
            );
          }
        });
      }),
      Effect.asVoid,
    ),
  );
};

// ---------------------------------------------------------------------------
// SQLite-backed workspace source catalog
// ---------------------------------------------------------------------------

export const acquireWorkspaceSourceCatalog = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof SourceCatalogStore>;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
  embedder?: Embedder;
  dependencies?: SourceCatalogDependencies;
}): Effect.Effect<ManagedWorkspaceSourceCatalog, unknown, never> => {
  const dependencies = {
    ...defaultSourceCatalogDependencies,
    ...input.dependencies,
  };
  const workspaceDatabase = resolveWorkspaceDatabase({
    dependencies,
    runtimeLocalWorkspace: input.runtimeLocalWorkspace,
  });

  if (!workspaceDatabase) {
    return Effect.fail(
      new Error("Runtime local workspace is required for the SQLite source catalog."),
    );
  }

  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const sqliteCatalogContext = yield* Layer.buildWithScope(
      dependencies.makeSqliteToolCatalogLive(input.embedder).pipe(
        Layer.provide(workspaceDatabase.queryLayer({
          ...(input.embedder
            ? { embeddingDimensions: input.embedder.dimensions }
            : {}),
        })),
      ),
      scope,
    );

    const catalog = Context.get(sqliteCatalogContext, SqliteToolCatalogService);

    return {
      catalog,
      close: Scope.close(scope, Exit.void),
    } satisfies ManagedWorkspaceSourceCatalog;
  });
};

export const createWorkspaceSourceCatalog = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof SourceCatalogStore>;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
  embedder?: Embedder;
  dependencies?: SourceCatalogDependencies;
}): ToolCatalog => {
  const withManagedSqliteCatalog = <A>(
    useCatalog: (catalog: ToolCatalog) => Effect.Effect<A, unknown, never>,
  ): Effect.Effect<A, unknown, never> =>
    provideRuntimeLocalWorkspace(
      Effect.acquireUseRelease(
        acquireWorkspaceSourceCatalog(input),
        ({ catalog }) => useCatalog(catalog),
        ({ close }) => close,
      ),
      input.runtimeLocalWorkspace,
    );

  return {
    searchTools: ({ query, namespace, sourceKey, limit }) =>
      withManagedSqliteCatalog((catalog) =>
        catalog.searchTools({
          query,
          ...(namespace !== undefined ? { namespace } : {}),
          ...(sourceKey !== undefined ? { sourceKey } : {}),
          limit,
        }),
      ),

    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      withManagedSqliteCatalog((catalog) =>
        catalog.listTools({
          ...(namespace !== undefined ? { namespace } : {}),
          ...(query !== undefined ? { query } : {}),
          limit,
          includeSchemas,
        }),
      ),

    listNamespaces: ({ limit }) =>
      withManagedSqliteCatalog((catalog) => catalog.listNamespaces({ limit })),

    getToolByPath: ({ path, includeSchemas }) =>
      withManagedSqliteCatalog((catalog) =>
        catalog.getToolByPath({ path, includeSchemas }),
      ),
  } satisfies ToolCatalog;
};

// ---------------------------------------------------------------------------
// Re-export indexer functions for use in sync flow
// ---------------------------------------------------------------------------

export { indexSource, removeSourceTools } from "../../../db/indexer";
export type { ToolToIndex } from "../../../db/indexer";
