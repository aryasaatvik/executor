import type {
  SearchHit,
  ToolCatalogEntry,
  ToolCatalog,
  ToolDescriptor,
  ToolNamespace,
  ToolPath,
} from "@executor/codemode-core";
import type { AccountId, Source, SourceId } from "../../model/index";
import * as Effect from "effect/Effect";

import type {
  ExecutionSourceCatalogStoreShape,
} from "./contracts";
import type { LoadedSourceCatalogToolIndexEntry } from "./ir-execution";

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

const queryTokens = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0);

const toToolDescriptor = (
  tool: LoadedSourceCatalogToolIndexEntry,
  includeSchemas: boolean,
): ToolDescriptor => ({
  path: tool.path as ToolPath,
  sourceKey: tool.descriptor.sourceKey,
  ...(tool.descriptor.interaction !== undefined && tool.descriptor.interaction !== null
    ? { interaction: tool.descriptor.interaction as "auto" | "required" }
    : {}),
  ...(tool.descriptor.providerKind !== undefined && tool.descriptor.providerKind !== null
    ? { providerKind: tool.descriptor.providerKind }
    : {}),
  ...(tool.capability.surface.summary !== null && tool.capability.surface.summary !== undefined
    ? { description: tool.capability.surface.summary }
    : tool.capability.surface.description !== null && tool.capability.surface.description !== undefined
      ? { description: tool.capability.surface.description }
      : {}),
  ...(tool.descriptor.contract
    ? {
        contract: {
          ...(tool.descriptor.contract.inputTypePreview !== undefined
            ? { inputTypePreview: tool.descriptor.contract.inputTypePreview }
            : {}),
          ...(tool.descriptor.contract.outputTypePreview !== undefined
            ? { outputTypePreview: tool.descriptor.contract.outputTypePreview }
            : {}),
          ...(includeSchemas && tool.descriptor.contract.inputSchema !== undefined
            ? { inputSchema: tool.descriptor.contract.inputSchema }
            : {}),
          ...(includeSchemas && tool.descriptor.contract.outputSchema !== undefined
            ? { outputSchema: tool.descriptor.contract.outputSchema }
            : {}),
        },
      }
    : {}),
});

const toCatalogEntry = (
  tool: LoadedSourceCatalogToolIndexEntry,
  includeSchemas: boolean,
): ToolCatalogEntry => ({
  descriptor: toToolDescriptor(tool, includeSchemas),
  namespace: tool.searchNamespace,
  searchText: tool.searchText,
});

const scoreCatalogEntry = (
  entry: ToolCatalogEntry,
  tokens: readonly string[],
): number => {
  if (tokens.length === 0) {
    return 0;
  }

  const haystack = [
    entry.descriptor.path,
    entry.namespace,
    entry.searchText,
    entry.descriptor.description,
    entry.descriptor.contract?.inputTypePreview,
    entry.descriptor.contract?.outputTypePreview,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (entry.descriptor.path.toLowerCase() === token) {
      score += 8;
      continue;
    }
    if (entry.descriptor.path.toLowerCase().includes(token)) {
      score += 4;
      continue;
    }
    if (haystack.includes(token)) {
      score += 1;
      continue;
    }
    return 0;
  }

  return score / tokens.length;
};

const filterCatalogEntries = (input: {
  entries: readonly LoadedSourceCatalogToolIndexEntry[];
  namespace?: string;
  sourceKey?: string;
}): readonly LoadedSourceCatalogToolIndexEntry[] =>
  input.entries.filter(
    (entry) =>
      (input.namespace === undefined || entry.searchNamespace === input.namespace)
      && (input.sourceKey === undefined || entry.descriptor.sourceKey === input.sourceKey),
  );

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
  sourceCatalogStore: ExecutionSourceCatalogStoreShape;
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
  sourceCatalogStore: ExecutionSourceCatalogStoreShape;
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
}): Effect.Effect<LoadedSourceCatalogToolIndexEntry | null, unknown> => {
  // TODO: This implementation requires engine's workspace database.
  // For now, return null — callers should fall back to JSON artifact loading.
  void input;
  return Effect.succeed(null);
};

export const createWorkspaceSourceCatalog = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: ExecutionSourceCatalogStoreShape;
}): ToolCatalog => {
  return {
    searchTools: ({ query, namespace, sourceKey, limit }) =>
      loadWorkspaceCatalogTools({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        sourceCatalogStore: input.sourceCatalogStore,
        includeSchemas: false,
      }).pipe(
        Effect.map((entries) =>
          filterCatalogEntries({
            entries,
            ...(namespace !== undefined ? { namespace } : {}),
            ...(sourceKey !== undefined ? { sourceKey } : {}),
          }),
        ),
        Effect.map((entries) => {
          const tokens = queryTokens(query);
          if (tokens.length === 0) {
            return [] satisfies readonly SearchHit[];
          }

          return entries
            .map((entry) => ({
              path: entry.path as ToolPath,
              score: scoreCatalogEntry(toCatalogEntry(entry, false), tokens),
            }))
            .filter((hit) => hit.score > 0)
            .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
            .slice(0, limit);
        }),
      ),

    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      loadWorkspaceCatalogTools({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        sourceCatalogStore: input.sourceCatalogStore,
        includeSchemas,
      }).pipe(
        Effect.map((entries) =>
          filterCatalogEntries({
            entries,
            ...(namespace !== undefined ? { namespace } : {}),
          }),
        ),
        Effect.map((entries) => {
          const tokens = query ? queryTokens(query) : [];
          const scoredEntries = entries
            .map((entry) => ({
              entry,
              score: tokens.length === 0
                ? 1
                : scoreCatalogEntry(toCatalogEntry(entry, includeSchemas), tokens),
            }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
            .slice(0, limit);

          return scoredEntries.map(({ entry }) => toToolDescriptor(entry, includeSchemas));
        }),
      ),

    listNamespaces: ({ limit }) =>
      loadWorkspaceCatalogTools({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        sourceCatalogStore: input.sourceCatalogStore,
        includeSchemas: false,
      }).pipe(
        Effect.map((entries) =>
          [...new Set(entries.map((entry) => entry.searchNamespace))]
            .sort((a, b) => a.localeCompare(b))
            .slice(0, limit)
            .map((namespace) => ({ namespace })) as readonly ToolNamespace[],
        ),
      ),

    getToolByPath: ({ path, includeSchemas }) =>
      loadWorkspaceCatalogToolByPath({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        sourceCatalogStore: input.sourceCatalogStore,
        path,
        includeSchemas,
      }).pipe(
        Effect.map((entry) => entry ? toToolDescriptor(entry, includeSchemas) : null),
      ),
  } satisfies ToolCatalog;
};
