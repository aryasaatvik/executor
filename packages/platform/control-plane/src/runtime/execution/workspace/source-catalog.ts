import type {
  ToolCatalog,
} from "@executor/codemode-core";
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
import type { ToolToIndex } from "../../../db/indexer";
import { join } from "node:path";

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
  sourceKey: tool.source.namespace ?? tool.source.id,
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
}): Effect.Effect<void, unknown, never> => {
  const dbPath = resolveWorkspaceCatalogDbPath(input.runtimeLocalWorkspace);
  if (!dbPath) {
    return Effect.void;
  }

  const workspaceStorageLayer = makeWorkspaceStorageLayer({
    workspaceConfigStore: input.workspaceConfigStore,
    workspaceStateStore: input.workspaceStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
  });
  const dbLayer = makeWorkspaceCatalogDbLayer(dbPath);

  return loadWorkspaceCatalogTools({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    sourceCatalogStore: input.sourceCatalogStore,
    includeSchemas: true,
  }).pipe(
    Effect.flatMap((tools) => {
      // Group tools by source for indexing
      const toolsBySource = new Map<string, {
        sourceId: string;
        sourceKey: string;
        tools: ToolToIndex[];
      }>();

      for (const tool of tools) {
        const sourceId = tool.source.id;
        if (!toolsBySource.has(sourceId)) {
          toolsBySource.set(sourceId, {
            sourceId,
            sourceKey: tool.source.namespace ?? tool.source.id,
            tools: [],
          });
        }
        toolsBySource.get(sourceId)!.tools.push(toToolToIndex(tool));
      }

      return Effect.forEach(
        [...toolsBySource.values()],
        (group) =>
          indexSource({
            sourceId: group.sourceId,
            sourceKey: group.sourceKey,
            tools: group.tools,
          }),
        { concurrency: 1 },
      );
    }),
    Effect.provide(workspaceStorageLayer),
    Effect.provide(dbLayer),
    Effect.catchAll((error) => {
      // Log but don't fail — fallback to in-memory if indexing fails
      return Effect.logWarning(
        `Failed to index workspace tools into SQLite: ${error instanceof Error ? error.message : String(error)}`,
      );
    }),
    Effect.asVoid,
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
}): ToolCatalog => {
  const dbPath = resolveWorkspaceCatalogDbPath(input.runtimeLocalWorkspace);

  // If we have a valid DB path, use the SQLite-backed catalog.
  // Otherwise, fall back gracefully with an empty catalog.
  if (!dbPath) {
    return createEmptySourceCatalog();
  }

  const dbLayer = makeWorkspaceCatalogDbLayer(dbPath);

  // Create the SQLite catalog wrapped with the DB layer.
  // Each catalog method's Effect is self-contained with `R = never`.
  // TODO: Wire embedder config from workspace settings to enable hybrid search.
  // For now, pass undefined to use FTS-only search.
  const sqliteCatalogEffect = createSqliteToolCatalog(undefined).pipe(
    Effect.provide(dbLayer),
  );

  // We need to resolve the catalog lazily per-method, since the catalog
  // creation itself is an Effect. Each method creates the catalog and
  // delegates to it.
  return {
    searchTools: ({ query, namespace, limit }) =>
      provideRuntimeLocalWorkspace(
        Effect.flatMap(sqliteCatalogEffect, (catalog) =>
          catalog.searchTools({
            query,
            ...(namespace !== undefined ? { namespace } : {}),
            limit,
          }),
        ),
        input.runtimeLocalWorkspace,
      ),

    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      provideRuntimeLocalWorkspace(
        Effect.flatMap(sqliteCatalogEffect, (catalog) =>
          catalog.listTools({
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
        Effect.flatMap(sqliteCatalogEffect, (catalog) =>
          catalog.listNamespaces({ limit }),
        ),
        input.runtimeLocalWorkspace,
      ),

    getToolByPath: ({ path, includeSchemas }) =>
      provideRuntimeLocalWorkspace(
        Effect.flatMap(sqliteCatalogEffect, (catalog) =>
          catalog.getToolByPath({ path, includeSchemas }),
        ),
        input.runtimeLocalWorkspace,
      ),
  } satisfies ToolCatalog;
};

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
