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
  RuntimeSourceCatalogStoreService,
  type LoadedSourceCatalogToolIndexEntry,
} from "../../catalog/source/runtime";
import type { RuntimeLocalWorkspaceState } from "../../local/runtime-context";
import {
  makeWorkspaceStorageLayer,
  type SourceArtifactStoreShape,
  type WorkspaceConfigStoreShape,
  type WorkspaceStateStoreShape,
  type WorkspaceStorageServices,
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
  syncSourceLifecycle,
} from "../../../db/indexer";
import type { SourceToIndex, ToolToIndex } from "../../../db/indexer";
import type { Embedder } from "../../../db/embedder";
import { embedSourceTools, removeSourceEmbeddings } from "../../../db/embed-indexer";
import { catalog_tool } from "../../../db/schema";
import { join } from "node:path";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";

type SourceCatalogDependencies = {
  makeSqliteToolCatalogLive?: typeof SqliteToolCatalogLive;
  makeWorkspaceCatalogDbLayer?: typeof makeWorkspaceCatalogDbLayer;
  makeWorkspaceCatalogQueryDbLayer?: typeof makeWorkspaceCatalogQueryDbLayer;
  indexSource?: typeof indexSource;
  removeSourceTools?: typeof removeSourceTools;
  syncSourceLifecycle?: typeof syncSourceLifecycle;
  embedSourceTools?: typeof embedSourceTools;
  removeSourceEmbeddings?: typeof removeSourceEmbeddings;
};

const defaultSourceCatalogDependencies: Required<SourceCatalogDependencies> = {
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
// DB path resolution
// ---------------------------------------------------------------------------

const WORKSPACE_CATALOG_DB_FILENAME = "catalog.db";

const resolveWorkspaceCatalogDbPath = (
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null,
): string | null => {
  if (!runtimeLocalWorkspace) {
    return null;
  }
  return join(
    runtimeLocalWorkspace.context.stateDirectory,
    WORKSPACE_CATALOG_DB_FILENAME,
  );
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

const semanticSearchSignature = (
  embedder?: Embedder,
): string | null =>
  embedder
    ? JSON.stringify({
      provider: embedder.provider,
      model: embedder.model,
      dimensions: embedder.dimensions,
    })
    : null;

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
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  includeSchemas: boolean;
}): Effect.Effect<
  readonly LoadedSourceCatalogToolIndexEntry[],
  Error,
  WorkspaceStorageServices
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
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  path: string;
  includeSchemas: boolean;
}): Effect.Effect<
  LoadedSourceCatalogToolIndexEntry | null,
  Error,
  WorkspaceStorageServices
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
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  embedder?: Embedder;
  dependencies?: SourceCatalogDependencies;
}): Effect.Effect<void, unknown, never> => {
  const dependencies = {
    ...defaultSourceCatalogDependencies,
    ...input.dependencies,
  };
  const dbPath = resolveWorkspaceCatalogDbPath(input.runtimeLocalWorkspace);
  if (!dbPath) {
    return Effect.fail(new Error("Workspace catalog DB path is unavailable."));
  }

  const workspaceStorageLayer = makeWorkspaceStorageLayer({
    workspaceConfigStore: input.workspaceConfigStore,
    workspaceStateStore: input.workspaceStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
  });
  const dbLayer = dependencies.makeWorkspaceCatalogDbLayer(dbPath, {
    ...(input.embedder ? { embeddingDimensions: input.embedder.dimensions } : {}),
  });

  return input.sourceCatalogStore.loadWorkspaceSourceCatalogToolIndex({
    workspaceId: input.workspaceId,
    actorAccountId: input.accountId,
    includeSchemas: true,
  }).pipe(
    Effect.flatMap((allTools) => {
      const activeSourceIds = new Set<SourceId>();
      const nextSemanticSearchSignature = semanticSearchSignature(input.embedder);

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
        const workspaceState = yield* input.workspaceStateStore.load(
          input.runtimeLocalWorkspace.context,
        );
        const previousSemanticSearchSignature =
          workspaceState.catalog.semanticSearchSignature;
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
          yield* input.workspaceStateStore.write({
            context: input.runtimeLocalWorkspace.context,
            state: {
              ...workspaceState,
              catalog: {
                semanticSearchSignature: nextSemanticSearchSignature,
              },
            },
          });
        }
      });
    }),
    Effect.provide(workspaceStorageLayer),
    Effect.provide(dbLayer),
    Effect.asVoid,
  );
};

// ---------------------------------------------------------------------------
// SQLite-backed workspace source catalog
// ---------------------------------------------------------------------------

export const acquireWorkspaceSourceCatalog = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
  embedder?: Embedder;
  dependencies?: SourceCatalogDependencies;
}): Effect.Effect<ManagedWorkspaceSourceCatalog, unknown, never> => {
  const dependencies = {
    ...defaultSourceCatalogDependencies,
    ...input.dependencies,
  };
  const dbPath = resolveWorkspaceCatalogDbPath(input.runtimeLocalWorkspace);

  if (!dbPath) {
    return Effect.fail(
      new Error("Runtime local workspace is required for the SQLite source catalog."),
    );
  }

  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const sqliteCatalogContext = yield* Layer.buildWithScope(
      dependencies.makeSqliteToolCatalogLive(input.embedder).pipe(
        Layer.provide(
          dependencies.makeWorkspaceCatalogQueryDbLayer(dbPath, {
            ...(input.embedder
              ? { embeddingDimensions: input.embedder.dimensions }
              : {}),
          }),
        ),
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
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
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
