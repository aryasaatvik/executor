// TODO: This file has extensive engine-internal and DB dependencies.
// Many of these should be split between control-plane services and worlds/local
// as the migration progresses. SQLite-specific logic should move to worlds/local.

import type {
  ToolCatalog,
} from "@executor/codemode-core";
import type { AccountId, Source, SourceId } from "../../model/index";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import type { LoadedSourceCatalogToolIndexEntry } from "./ir-execution";

// TODO: These engine-internal types and functions should be replaced
// with control-plane port interfaces. For now, define minimal placeholders.

/** Placeholder — engine's RuntimeLocalWorkspaceState */
type RuntimeLocalWorkspaceState = {
  context: {
    stateDirectory: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
} | null;

/** Placeholder — engine's WorkspaceConfigStoreShape */
type WorkspaceConfigStoreShape = unknown;

/** Placeholder — engine's SourceCatalogStore service shape */
type SourceCatalogStoreShape = {
  loadWorkspaceSourceCatalogToolIndex: (input: {
    workspaceId: Source["workspaceId"];
    actorAccountId: AccountId;
    includeSchemas: boolean;
  }) => Effect.Effect<readonly LoadedSourceCatalogToolIndexEntry[], Error>;
  loadWorkspaceSourceCatalogToolByPath: (input: {
    workspaceId: Source["workspaceId"];
    path: string;
    actorAccountId: AccountId;
    includeSchemas: boolean;
  }) => Effect.Effect<LoadedSourceCatalogToolIndexEntry | null, Error>;
};

/** Placeholder — engine's SourceStore service shape */
type SourceStoreShape = {
  loadSourceById: (input: {
    workspaceId: Source["workspaceId"];
    sourceId: SourceId;
    actorAccountId: AccountId;
  }) => Effect.Effect<Source, Error>;
};

/** Placeholder — engine's Embedder */
type Embedder = {
  dimensions: number;
  [key: string]: unknown;
};

/** Placeholder — engine's ToolToIndex */
export type ToolToIndex = {
  toolId: string;
  path: string;
  sourceId: SourceId;
  sourceKey: string;
  namespace: string;
  searchText: string;
  title?: string;
  description?: string;
  inputSchemaJson?: unknown;
  outputSchemaJson?: unknown;
  inputTypePreview?: string;
  outputTypePreview?: string;
  interaction: string;
  providerKind?: string;
  capabilityJson: string;
  executableJson: string;
};

/** Placeholder — engine's SourceToIndex */
export type SourceToIndex = {
  sourceId: SourceId;
  workspaceId: Source["workspaceId"];
  catalogId: string;
  catalogRevisionId: string;
  status: string;
  enabled: boolean;
  sourceHash: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ManagedWorkspaceSourceCatalog = {
  catalog: ToolCatalog;
  close: Effect.Effect<void, never, never>;
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
  catalogId: `${source.id}:catalog`,
  catalogRevisionId: `${source.id}:revision`,
  status: source.status,
  enabled: source.enabled,
  sourceHash: source.sourceHash ?? null,
  lastError: source.lastError ?? null,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});

// ---------------------------------------------------------------------------
// Load tools from JSON artifacts
// ---------------------------------------------------------------------------

export const loadWorkspaceCatalogTools = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: SourceCatalogStoreShape;
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
  sourceCatalogStore: SourceCatalogStoreShape;
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
 * Load a tool by path from SQLite for invocation.
 *
 * TODO: This function depends on engine's WorkspaceDatabase and SQLite
 * indexer. It should move to worlds/local once the world infrastructure
 * is in place.
 */
export const loadWorkspaceCatalogToolByPathFromDb = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  path: string;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  sourceStore: SourceStoreShape;
}): Effect.Effect<LoadedSourceCatalogToolIndexEntry | null, unknown> => {
  // TODO: This implementation requires engine's workspace database.
  // For now, return null — callers should fall back to JSON artifact loading.
  if (!input.runtimeLocalWorkspace) {
    return Effect.succeed(null);
  }

  return Effect.succeed(null);
};

// ---------------------------------------------------------------------------
// Index workspace tools into SQLite
// ---------------------------------------------------------------------------

/**
 * Load all tools from the JSON artifact store and index them into
 * the SQLite catalog.
 *
 * TODO: This function depends on engine's workspace database, SQLite
 * indexer, and embedder. It should move to worlds/local once the
 * world infrastructure is in place.
 */
export const indexWorkspaceToolsIntoSqlite = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: SourceCatalogStoreShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  embedder?: Embedder;
}): Effect.Effect<void, unknown, never> => {
  // TODO: Requires engine's workspace database and SQLite indexer.
  // Stub implementation — the real indexing will live in worlds/local.
  return Effect.void;
};

// ---------------------------------------------------------------------------
// SQLite-backed workspace source catalog
// ---------------------------------------------------------------------------

export const acquireWorkspaceSourceCatalog = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: SourceCatalogStoreShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  embedder?: Embedder;
}): Effect.Effect<ManagedWorkspaceSourceCatalog, unknown, never> => {
  // TODO: Requires engine's workspace database and SQLite tool catalog.
  // Stub implementation — the real catalog will live in worlds/local.
  return Effect.fail(
    new Error("SQLite workspace source catalog not yet migrated to control-plane."),
  );
};

export const createWorkspaceSourceCatalog = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: SourceCatalogStoreShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  embedder?: Embedder;
}): ToolCatalog => {
  // TODO: Requires engine's workspace database. Stub returning empty results.
  return {
    searchTools: () => Effect.succeed([]),
    listTools: () => Effect.succeed([]),
    listNamespaces: () => Effect.succeed([]),
    getToolByPath: () => Effect.succeed(null),
  } as unknown as ToolCatalog;
};
