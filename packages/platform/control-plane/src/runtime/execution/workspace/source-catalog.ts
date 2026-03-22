import type {
  ToolCatalog,
} from "@executor/codemode-core";
import { createToolCatalogFromEntries } from "@executor/codemode-core";
import type { AccountId, Source } from "#schema";
import * as Effect from "effect/Effect";

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
import { createSqliteToolCatalog } from "../../../db/catalog";
import { makeWorkspaceCatalogDbLayer } from "../../../db/setup";
import { indexSource, deactivateSourceTools, removeSourceTools } from "../../../db/indexer";
import type { SourceToIndex, ToolToIndex } from "../../../db/indexer";
import type { Embedder } from "../../../db/embedder";
import { embedSourceTools, removeSourceEmbeddings } from "../../../db/embed-indexer";
import { catalog_tool } from "../../../db/schema";
import { join } from "node:path";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";

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
}): Effect.Effect<boolean, never, never> => {
  const dbPath = resolveWorkspaceCatalogDbPath(input.runtimeLocalWorkspace);
  if (!dbPath) {
    return Effect.succeed(false);
  }

  const workspaceStorageLayer = makeWorkspaceStorageLayer({
    workspaceConfigStore: input.workspaceConfigStore,
    workspaceStateStore: input.workspaceStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
  });
  const dbLayer = makeWorkspaceCatalogDbLayer(dbPath, {
    ...(input.embedder ? { embeddingDimensions: input.embedder.dimensions } : {}),
  });

  return loadWorkspaceCatalogTools({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    sourceCatalogStore: input.sourceCatalogStore,
    includeSchemas: true,
  }).pipe(
    Effect.flatMap((tools) => {
      const activeSourceIds = new Set<string>();
      const nextSemanticSearchSignature = semanticSearchSignature(input.embedder);

      // Group tools by source for indexing
      const toolsBySource = new Map<string, {
        sourceId: string;
        sourceKey: string;
        source: SourceToIndex;
        tools: ToolToIndex[];
      }>();

      for (const tool of tools) {
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
        toolsBySource.get(sourceId)!.tools.push(toToolToIndex(tool));
      }

      return Effect.gen(function* () {
        const db = yield* SqliteDrizzle;
        const workspaceState = yield* input.workspaceStateStore.load(
          input.runtimeLocalWorkspace.context,
        );
        const previousSemanticSearchSignature =
          workspaceState.catalog?.semanticSearchSignature ?? null;
        const shouldRebuildEmbeddings =
          previousSemanticSearchSignature !== nextSemanticSearchSignature;
        const indexedSources = yield* db
          .selectDistinct({
            sourceId: catalog_tool.source_id,
            sourceKey: catalog_tool.source_key,
          })
          .from(catalog_tool);

        for (const indexedSource of indexedSources) {
          if (activeSourceIds.has(indexedSource.sourceId)) {
            continue;
          }

          yield* removeSourceTools(indexedSource.sourceId);
          yield* removeSourceEmbeddings(indexedSource.sourceKey);
        }

        yield* Effect.forEach(
          [...toolsBySource.values()],
          (group) =>
            Effect.gen(function* () {
              const result = yield* indexSource({
                sourceId: group.sourceId,
                sourceKey: group.sourceKey,
                source: group.source,
                tools: group.tools,
              });

              const toolsToEmbed = shouldRebuildEmbeddings
                ? group.tools
                : result.changedTools;

              if (input.embedder && toolsToEmbed.length > 0) {
                yield* embedSourceTools({
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
                ...(workspaceState.catalog ?? {}),
                semanticSearchSignature: nextSemanticSearchSignature,
              },
            },
          });
        }
      });
    }),
    Effect.provide(workspaceStorageLayer),
    Effect.provide(dbLayer),
    Effect.as(true),
    Effect.catchAll((error) => {
      return Effect.logWarning(
        `Failed to index workspace tools into SQLite: ${error instanceof Error ? error.message : String(error)}`,
      ).pipe(Effect.as(false));
    }),
  );
};

// ---------------------------------------------------------------------------
// SQLite-backed workspace source catalog
// ---------------------------------------------------------------------------

export const createWorkspaceSourceCatalog = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
  embedder?: Embedder;
  sqliteCatalogReady?: boolean;
}): ToolCatalog => {
  const dbPath = resolveWorkspaceCatalogDbPath(input.runtimeLocalWorkspace);
  const jsonCatalog = createJsonSourceCatalog(input);

  if (!dbPath) {
    return jsonCatalog;
  }

  if (input.sqliteCatalogReady === false) {
    return jsonCatalog;
  }

  const dbLayer = makeWorkspaceCatalogDbLayer(dbPath, {
    ...(input.embedder ? { embeddingDimensions: input.embedder.dimensions } : {}),
  });

  const sqliteCatalogEffect = Effect.runSync(
    Effect.cached(
      createSqliteToolCatalog(input.embedder).pipe(
        Effect.provide(dbLayer),
      ),
    ),
  );

  const withSqliteFallback = <A>(
    sqliteEffect: Effect.Effect<A, unknown, never>,
    fallback: () => Effect.Effect<A, unknown, never>,
  ) =>
    sqliteEffect.pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(
          `SQLite workspace catalog unavailable, falling back to JSON catalog: ${error instanceof Error ? error.message : String(error)}`,
        ).pipe(Effect.zipRight(fallback())),
      ),
    )

  return {
    searchTools: ({ query, namespace, sourceKey, limit }) =>
      provideRuntimeLocalWorkspace(
        withSqliteFallback(
          Effect.flatMap(sqliteCatalogEffect, (catalog) =>
            catalog.searchTools({
              query,
              ...(namespace !== undefined ? { namespace } : {}),
              ...(sourceKey !== undefined ? { sourceKey } : {}),
              limit,
            }),
          ),
          () =>
            jsonCatalog.searchTools({
              query,
              ...(namespace !== undefined ? { namespace } : {}),
              ...(sourceKey !== undefined ? { sourceKey } : {}),
              limit,
            }),
        ),
        input.runtimeLocalWorkspace,
      ),

    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      provideRuntimeLocalWorkspace(
        withSqliteFallback(
          Effect.flatMap(sqliteCatalogEffect, (catalog) =>
            catalog.listTools({
              ...(namespace !== undefined ? { namespace } : {}),
              ...(query !== undefined ? { query } : {}),
              limit,
              includeSchemas,
            }),
          ),
          () =>
            jsonCatalog.listTools({
              ...(namespace !== undefined ? { namespace } : {}),
              ...(query !== undefined ? { query } : {}),
              limit,
              includeSchemas,
            }),
        ),
        input.runtimeLocalWorkspace,
      ),

    listNamespaces: ({ limit }) =>
      provideRuntimeLocalWorkspace(
        withSqliteFallback(
          Effect.flatMap(sqliteCatalogEffect, (catalog) =>
            catalog.listNamespaces({ limit }),
          ),
          () => jsonCatalog.listNamespaces({ limit }),
        ),
        input.runtimeLocalWorkspace,
      ),

    getToolByPath: ({ path, includeSchemas }) =>
      provideRuntimeLocalWorkspace(
        withSqliteFallback(
          Effect.flatMap(sqliteCatalogEffect, (catalog) =>
            catalog.getToolByPath({ path, includeSchemas }),
          ),
          () => jsonCatalog.getToolByPath({ path, includeSchemas }),
        ),
        input.runtimeLocalWorkspace,
      ),
  } satisfies ToolCatalog;
};

const createJsonSourceCatalog = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
}): ToolCatalog => {
  const workspaceStorageLayer = makeWorkspaceStorageLayer({
    workspaceConfigStore: input.workspaceConfigStore,
    workspaceStateStore: input.workspaceStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
  });

  const loadCatalog = (includeSchemas: boolean) =>
    loadWorkspaceCatalogTools({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      sourceCatalogStore: input.sourceCatalogStore,
      includeSchemas,
    }).pipe(
      Effect.map((tools) =>
        createToolCatalogFromEntries({
          entries: tools.map((tool) => ({
            descriptor: tool.descriptor,
            namespace: tool.searchNamespace,
            searchText: tool.searchText,
          })),
        }),
      ),
      Effect.provide(workspaceStorageLayer),
    )

  return {
    searchTools: ({ query, namespace, sourceKey, limit }) =>
      loadCatalog(false).pipe(
        Effect.flatMap((catalog) =>
          catalog.searchTools({
            query,
            ...(namespace !== undefined ? { namespace } : {}),
            ...(sourceKey !== undefined ? { sourceKey } : {}),
            limit,
          }),
        ),
      ),
    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      loadCatalog(includeSchemas).pipe(
        Effect.flatMap((catalog) =>
          catalog.listTools({
            ...(namespace !== undefined ? { namespace } : {}),
            ...(query !== undefined ? { query } : {}),
            limit,
            includeSchemas,
          }),
        ),
      ),
    listNamespaces: ({ limit }) =>
      loadCatalog(false).pipe(
        Effect.flatMap((catalog) => catalog.listNamespaces({ limit })),
      ),
    getToolByPath: ({ path, includeSchemas }) =>
      loadWorkspaceCatalogToolByPath({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        sourceCatalogStore: input.sourceCatalogStore,
        path,
        includeSchemas,
      }).pipe(
        Effect.map((tool) => tool?.descriptor ?? null),
        Effect.provide(workspaceStorageLayer),
      ),
  } satisfies ToolCatalog
}

// ---------------------------------------------------------------------------
// Empty catalog fallback (no local workspace)
// ---------------------------------------------------------------------------

const createEmptySourceCatalog = (): ToolCatalog => ({
  searchTools: () => Effect.succeed([]),
  listTools: () => Effect.succeed([]),
  listNamespaces: () => Effect.succeed([]),
  getToolByPath: () => Effect.succeed(null),
});

// ---------------------------------------------------------------------------
// Re-export indexer functions for use in sync flow
// ---------------------------------------------------------------------------

export { indexSource, deactivateSourceTools, removeSourceTools } from "../../../db/indexer";
export type { ToolToIndex } from "../../../db/indexer";
