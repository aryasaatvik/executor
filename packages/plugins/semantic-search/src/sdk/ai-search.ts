import type {
  AiSearchInstance,
  AiSearchItemInfo,
  AiSearchSearchResponse,
} from "@cloudflare/workers-types";
import {
  ExecutionToolError,
  type Executor,
  type PagedResult,
  type PluginStorageCollectionFacade,
  type ToolDiscoveryProvider,
  type ToolDiscoveryResult,
} from "@executor-js/sdk/core";
import { Effect, Result } from "effect";

import { type AiSearchItemRow, aiSearchItems, type AiSearchItemStatus } from "./collections";
import {
  collectToolSearchDocument,
  listToolManifests,
  toolItemKey,
  type ToolSearchDocument,
} from "./documents";
import { SemanticSearchError } from "./errors";
import { cyrb53 } from "./fingerprint";
import type {
  SemanticSearchReindexBatchInput,
  SemanticSearchReindexBatchResult,
  SemanticSearchRefreshResult,
  SemanticSearchResultPage,
  SemanticSearchStatus,
  ToolSearchBackendFactory,
} from "./tool-search-backend";
import type { ToolSearchIndex } from "./tool-search-index";

export interface AiSearchToolSearchBackendOptions {
  readonly aiSearch: Pick<AiSearchInstance, "items" | "search" | "stats"> | undefined;
  readonly namespace?: string;
}

type ItemsCollection = PluginStorageCollectionFacade<typeof aiSearchItems>;

export interface AiSearchToolSearchBackendStorage {
  readonly aiSearchItems: ItemsCollection;
  readonly owner: "org" | "user";
}

const DEFAULT_SEARCH_LIMIT = 20;
const AI_SEARCH_UPLOAD_CONCURRENCY = 2;
const AI_SEARCH_UPLOAD_BATCH_SIZE = 25;
// Cloudflare's default reranking threshold (0.4) drops short, valid catalog
// queries such as "search web" before their hybrid matches reach the caller.
// Keep AI Search authoritative while lowering only its native retrieval/rerank
// cutoff for this sparse tool catalog.
const AI_SEARCH_MATCH_THRESHOLD = 0.1;

const nowIso = (): string => new Date().toISOString();

const isReusableRemoteStatus = (status: string | undefined): boolean =>
  status === undefined || status === "queued" || status === "running" || status === "completed";

const toStatus = (status: string | undefined): AiSearchItemStatus =>
  status === "queued" || status === "running" || status === "completed" || status === "error"
    ? status
    : status === undefined
      ? "queued"
      : "error";

const toItemName = (document: ToolSearchDocument): string =>
  `tool-${cyrb53(`${document.path}\u0000${document.fingerprint}`).toString(36)}.md`;

const normalizeBatchInput = (
  input: SemanticSearchReindexBatchInput,
): SemanticSearchReindexBatchInput => ({
  offset: Math.max(0, Math.floor(input.offset)),
  pageSize: Math.max(1, Math.floor(input.pageSize)),
  ...(input.maxTools === undefined ? {} : { maxTools: Math.max(0, Math.floor(input.maxTools)) }),
});

const mapStorageError =
  (message: string) =>
  (cause: unknown): SemanticSearchError =>
    new SemanticSearchError({ message, cause });

const mapUploadError =
  (document: ToolSearchDocument) =>
  (cause: unknown): SemanticSearchError =>
    new SemanticSearchError({
      message: `Failed to upload AI Search item "${document.path}".`,
      cause,
    });

const notConfigured = (): Effect.Effect<never, SemanticSearchError> =>
  Effect.fail(
    new SemanticSearchError({
      message: "Semantic search is not configured (missing AI Search).",
    }),
  );

const unavailableIndex: ToolSearchIndex.Service = {
  create: () => notConfigured(),
  scan: () => notConfigured(),
  chunk: () => notConfigured(),
  embed: () => notConfigured(),
  commit: () => notConfigured(),
  fail: () => notConfigured(),
  reconcile: () => notConfigured(),
  status: () => notConfigured(),
  complete: () => notConfigured(),
};

const deleteItem = (
  aiSearch: Pick<AiSearchInstance, "items">,
  itemId: string,
): Effect.Effect<void, SemanticSearchError> =>
  Effect.tryPromise({
    try: () => aiSearch.items.delete(itemId),
    catch: (cause) =>
      new SemanticSearchError({
        message: `Failed to delete AI Search item "${itemId}".`,
        cause,
      }),
  }).pipe(Effect.asVoid);

const deleteItemBestEffort = (
  aiSearch: Pick<AiSearchInstance, "items">,
  itemId: string,
): Effect.Effect<void, never> => deleteItem(aiSearch, itemId).pipe(Effect.catch(() => Effect.void));

const getAiSearchItem = (
  aiSearch: Pick<AiSearchInstance, "items">,
  itemId: string,
): Effect.Effect<AiSearchItemInfo, SemanticSearchError> =>
  Effect.tryPromise({
    try: () => aiSearch.items.get(itemId).info(),
    catch: (cause) =>
      new SemanticSearchError({
        message: `Failed to get AI Search item "${itemId}".`,
        cause,
      }),
  });

const toIndexedItemRow = (
  document: ToolSearchDocument,
  uploaded: AiSearchItemInfo,
  pendingDeleteItemId?: string,
): AiSearchItemRow => ({
  path: document.path,
  key: uploaded.key,
  itemId: uploaded.id,
  name: document.name,
  description: document.description,
  integration: document.integration,
  connection: document.connection,
  plugin: document.plugin,
  fingerprint: document.fingerprint,
  status: toStatus(uploaded.status),
  updatedAt: nowIso(),
  ...(pendingDeleteItemId === undefined ? {} : { pendingDeleteItemId }),
});

interface UploadedDocument {
  readonly deleteOnStorageFailure: boolean;
  readonly uploadedItemId: string;
  readonly key: string;
  readonly row: AiSearchItemRow;
}

const uploadDocument = (
  aiSearch: Pick<AiSearchInstance, "items">,
  document: ToolSearchDocument,
  previous: AiSearchItemRow | undefined,
  remote: AiSearchItemInfo | undefined,
): Effect.Effect<UploadedDocument, SemanticSearchError> =>
  Effect.gen(function* () {
    const itemName = toItemName(document);
    if (remote !== undefined && isReusableRemoteStatus(remote.status)) {
      const pendingDeleteItemId = previous?.pendingDeleteItemId;
      if (pendingDeleteItemId !== undefined && remote.status === "completed") {
        yield* deleteItemBestEffort(aiSearch, pendingDeleteItemId);
        return {
          deleteOnStorageFailure: false,
          uploadedItemId: remote.id,
          key: document.path,
          row: toIndexedItemRow(document, remote),
        };
      }
      return {
        deleteOnStorageFailure: false,
        uploadedItemId: remote.id,
        key: document.path,
        row: toIndexedItemRow(document, remote, pendingDeleteItemId),
      };
    }

    if (remote !== undefined) {
      yield* deleteItemBestEffort(aiSearch, remote.id);
    }

    const uploaded = yield* Effect.tryPromise({
      try: () =>
        aiSearch.items.upload(itemName, document.content, {
          metadata: document.metadata,
        }),
      catch: mapUploadError(document),
    });

    const pendingDeleteItemId =
      previous !== undefined && previous.key !== itemName
        ? previous.itemId
        : previous?.pendingDeleteItemId;
    if (pendingDeleteItemId !== undefined && uploaded.status === "completed") {
      yield* deleteItemBestEffort(aiSearch, pendingDeleteItemId);
    }

    return {
      deleteOnStorageFailure: true,
      uploadedItemId: uploaded.id,
      key: document.path,
      row: toIndexedItemRow(
        document,
        uploaded,
        uploaded.status === "completed" ? undefined : pendingDeleteItemId,
      ),
    };
  });

export const reindexAiSearchBatch = (input: {
  readonly executor: Executor;
  readonly aiSearch: Pick<AiSearchInstance, "items"> | undefined;
  readonly items: ItemsCollection;
  readonly owner: "user" | "org";
  readonly namespace: string;
  readonly offset: number;
  readonly pageSize: number;
  readonly maxTools?: number;
}): Effect.Effect<SemanticSearchReindexBatchResult, SemanticSearchError> => {
  if (!input.aiSearch) return notConfigured();
  const aiSearch = input.aiSearch;
  return Effect.gen(function* () {
    const batch = normalizeBatchInput(input);
    const [manifests, integrations] = yield* Effect.all(
      [
        listToolManifests(input.executor, { maxTools: batch.maxTools }),
        input.executor.integrations.list().pipe(
          Effect.mapError(
            (cause) =>
              new SemanticSearchError({
                message: "Failed to list integration context for AI Search indexing.",
                cause,
              }),
          ),
        ),
      ] as const,
      { concurrency: 2 },
    );
    const integrationBySlug = new Map(
      integrations.map((integration) => [String(integration.slug), integration] as const),
    );
    const page = manifests.slice(batch.offset, batch.offset + batch.pageSize);
    const nextOffset =
      batch.offset + page.length < manifests.length ? batch.offset + page.length : null;
    const shouldRemoveStale = batch.maxTools === undefined && nextOffset === null;
    const livePaths = new Set(shouldRemoveStale ? manifests.map((manifest) => manifest.path) : []);
    const existingByPath = yield* input.items
      .getManyForOwner({
        owner: input.owner,
        keys: page.map((manifest) => manifest.path),
      })
      .pipe(
        Effect.map((entries) => new Map([...entries].map(([key, entry]) => [key, entry.data]))),
        Effect.mapError(mapStorageError("Failed to load AI Search item rows for this batch.")),
      );
    const prepared = page.map((manifest) => ({
      manifest,
      integration: integrationBySlug.get(manifest.integration),
      fingerprint: toolItemKey(manifest, integrationBySlug.get(manifest.integration)),
      previous: existingByPath.get(manifest.path),
    }));
    const remoteCandidates = prepared.flatMap(({ previous, fingerprint }) =>
      previous?.fingerprint === fingerprint ? [previous] : [],
    );
    const remoteLookupResults = yield* Effect.forEach(
      remoteCandidates,
      (previous) =>
        getAiSearchItem(aiSearch, previous.itemId).pipe(
          Effect.map((item) => [previous, item] as const),
          Effect.result,
        ),
      { concurrency: AI_SEARCH_UPLOAD_CONCURRENCY },
    );
    const remoteByKey = new Map<string, AiSearchItemInfo>();
    const remoteLookupFailures = new Set<string>();
    for (const [index, result] of remoteLookupResults.entries()) {
      const previous = remoteCandidates[index];
      if (Result.isSuccess(result)) {
        remoteByKey.set(result.success[0].key, result.success[1]);
        continue;
      }
      if (previous !== undefined) remoteLookupFailures.add(previous.key);
      console.warn(
        JSON.stringify({
          event: "tool_search_index_remote_lookup_failed",
          key: previous?.key,
          itemId: previous?.itemId,
          cause: result.failure,
        }),
      );
    }
    let skipped = 0;
    const failedPaths: string[] = [];
    const changed: {
      readonly manifest: (typeof manifests)[number];
      readonly integration?: (typeof integrations)[number];
      readonly previous?: AiSearchItemRow;
    }[] = [];

    for (const { manifest, integration, fingerprint, previous } of prepared) {
      const remote = previous === undefined ? undefined : remoteByKey.get(previous.key);
      if (previous !== undefined && remoteLookupFailures.has(previous.key)) {
        failedPaths.push(manifest.path);
        continue;
      }
      if (
        previous?.fingerprint === fingerprint &&
        remote !== undefined &&
        isReusableRemoteStatus(remote.status) &&
        previous.pendingDeleteItemId === undefined
      ) {
        skipped += 1;
        continue;
      }
      changed.push({
        manifest,
        ...(integration === undefined ? {} : { integration }),
        ...(previous === undefined ? {} : { previous }),
      });
    }

    const uploadResults = yield* Effect.forEach(
      changed,
      ({ manifest, integration, previous }) =>
        collectToolSearchDocument(input.executor, manifest, integration).pipe(
          Effect.flatMap((document) =>
            uploadDocument(aiSearch, document, previous, remoteByKey.get(toItemName(document))),
          ),
          Effect.result,
        ),
      { concurrency: AI_SEARCH_UPLOAD_CONCURRENCY },
    );
    const uploaded: UploadedDocument[] = [];
    for (const [index, result] of uploadResults.entries()) {
      if (Result.isSuccess(result)) {
        uploaded.push(result.success);
      } else {
        const path = changed[index]?.manifest.path;
        if (path !== undefined) failedPaths.push(path);
        console.warn(
          JSON.stringify({
            event: "tool_search_index_item_failed",
            path,
            cause: result.failure,
          }),
        );
      }
    }

    if (uploaded.length > 0) {
      yield* input.items
        .putMany({
          owner: input.owner,
          entries: uploaded.map((entry) => ({
            key: entry.key,
            data: entry.row,
          })),
        })
        .pipe(
          Effect.tapError(() =>
            Effect.forEach(
              uploaded.filter((entry) => entry.deleteOnStorageFailure),
              (entry) => deleteItemBestEffort(aiSearch, entry.uploadedItemId),
              {
                concurrency: AI_SEARCH_UPLOAD_CONCURRENCY,
                discard: true,
              },
            ),
          ),
          Effect.mapError(mapStorageError("Failed to record AI Search item rows.")),
        );
    }

    const removedEntries = shouldRemoveStale
      ? (yield* input.items
          .list()
          .pipe(Effect.mapError(mapStorageError("Failed to list AI Search item rows.")))).filter(
          (entry) => !livePaths.has(entry.key),
        )
      : [];
    if (removedEntries.length > 0) {
      yield* input.items
        .removeMany({
          owner: input.owner,
          keys: removedEntries.map((entry) => entry.key),
        })
        .pipe(Effect.mapError(mapStorageError("Failed to remove stale AI Search item rows.")));
      yield* Effect.forEach(
        removedEntries,
        (entry) => deleteItemBestEffort(aiSearch, entry.data.itemId),
        { concurrency: AI_SEARCH_UPLOAD_CONCURRENCY, discard: true },
      );
    }

    return {
      namespace: input.namespace,
      total: manifests.length,
      indexed: uploaded.length,
      ...(failedPaths.length === 0 ? {} : { failed: failedPaths.length }),
      skipped,
      removed: removedEntries.length,
      offset: batch.offset,
      pageSize: batch.pageSize,
      nextOffset,
    };
  });
};

export const reindexAiSearch = (input: {
  readonly executor: Executor;
  readonly aiSearch: Pick<AiSearchInstance, "items"> | undefined;
  readonly items: ItemsCollection;
  readonly owner: "user" | "org";
  readonly namespace: string;
  readonly maxTools?: number;
}): Effect.Effect<SemanticSearchRefreshResult, SemanticSearchError> =>
  Effect.gen(function* () {
    let nextOffset: number | null = 0;
    let total = 0;
    let indexed = 0;
    let failed = 0;
    let skipped = 0;
    let removed = 0;

    while (nextOffset !== null) {
      const result: SemanticSearchReindexBatchResult = yield* reindexAiSearchBatch({
        ...input,
        offset: nextOffset,
        pageSize: AI_SEARCH_UPLOAD_BATCH_SIZE,
      });
      total = result.total;
      indexed += result.indexed;
      failed += result.failed ?? 0;
      skipped += result.skipped;
      removed += result.removed;
      nextOffset = result.nextOffset;
    }

    return {
      namespace: input.namespace,
      total,
      indexed,
      ...(failed === 0 ? {} : { failed }),
      skipped,
      removed,
    };
  });

export const statusAiSearch = (input: {
  readonly aiSearch: Pick<AiSearchInstance, "stats">;
  readonly items: ItemsCollection;
  readonly namespace: string;
}): Effect.Effect<SemanticSearchStatus, SemanticSearchError> =>
  Effect.gen(function* () {
    const [rows, stats] = yield* Effect.all(
      [
        input.items.list().pipe(Effect.mapError(mapStorageError("Failed to list AI Search rows."))),
        Effect.tryPromise({
          try: () => input.aiSearch.stats(),
          catch: (cause) =>
            new SemanticSearchError({
              message: "Failed to read AI Search status.",
              cause,
            }),
        }),
      ] as const,
      { concurrency: 2 },
    );
    return {
      namespace: input.namespace,
      indexed: rows.length,
      lexical: null,
      queued: stats.queued ?? 0,
      running: stats.running ?? 0,
      completed: stats.completed ?? 0,
      error: stats.error ?? 0,
      skipped: stats.skipped ?? 0,
      outdated: stats.outdated ?? 0,
      ...(stats.last_activity ? { lastActivity: stats.last_activity } : {}),
    };
  });

const matchesNamespace = (path: string, namespace: string | undefined): boolean =>
  !namespace || path === namespace || path.startsWith(`${namespace}.`);

const getStringMetadata = (
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
) => {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
};

const chunkToResult = (
  chunk: AiSearchSearchResponse["chunks"][number],
): ToolDiscoveryResult | null => {
  const metadata = chunk.item?.metadata;
  const path = getStringMetadata(metadata, "path");
  const name = getStringMetadata(metadata, "name");
  const integration = getStringMetadata(metadata, "integration");
  if (!path || !name || !integration) return null;
  return {
    path,
    name,
    description: getStringMetadata(metadata, "description"),
    integration,
    score: chunk.score,
  };
};

export const makeAiSearchToolDiscoveryProvider = (deps: {
  readonly aiSearch: Pick<AiSearchInstance, "search"> | undefined;
}): ToolDiscoveryProvider | undefined => {
  if (!deps.aiSearch) return undefined;
  const aiSearch = deps.aiSearch;
  return {
    searchTools: (input) =>
      Effect.gen(function* () {
        const query = input.query.trim();
        if (!query) {
          return { items: [], total: 0, hasMore: false, nextOffset: null };
        }
        const integration = input.namespace?.split(".", 1)[0];
        const response = yield* Effect.tryPromise({
          try: () =>
            aiSearch.search({
              messages: [{ role: "user", content: query }],
              ai_search_options: {
                retrieval: {
                  retrieval_type: "hybrid",
                  match_threshold: AI_SEARCH_MATCH_THRESHOLD,
                  max_num_results: 50,
                  ...(integration ? { filters: { integration: { $eq: integration } } } : {}),
                  return_on_failure: true,
                },
                reranking: { enabled: true, match_threshold: AI_SEARCH_MATCH_THRESHOLD },
              },
            }),
          catch: (cause) =>
            new ExecutionToolError({
              message: "AI Search tool search failed.",
              cause,
            }),
        });

        // AI Search carries the canonical tool metadata on every chunk. Its provider-owned
        // item key may be rewritten during upload, but `path` is the stable identity that
        // clients use. Do not gate a successful AI Search result through the local upload
        // ledger: Cloudflare can finish indexing before that status projection advances.
        // The ledger remains the indexer's recovery/status record, not query authority.
        const chunkResults = (response.chunks ?? []).flatMap((chunk) => {
          const result = chunkToResult(chunk);
          return result === null ? [] : [result];
        });
        const bestByPath = new Map<string, ToolDiscoveryResult>();
        for (const result of chunkResults) {
          if (!matchesNamespace(result.path, input.namespace)) continue;
          const previous = bestByPath.get(result.path);
          if (!previous || result.score > previous.score) bestByPath.set(result.path, result);
        }
        const ordered = [...bestByPath.values()].sort(
          (left, right) => right.score - left.score || left.path.localeCompare(right.path),
        );
        const pageItems = ordered.slice(input.offset, input.offset + input.limit);
        return {
          items: pageItems,
          total: ordered.length,
          hasMore: input.offset + pageItems.length < ordered.length,
          nextOffset:
            input.offset + pageItems.length < ordered.length
              ? input.offset + pageItems.length
              : null,
        } satisfies PagedResult<ToolDiscoveryResult>;
      }),
  };
};

export const makeAiSearchToolSearchBackend = (
  options: AiSearchToolSearchBackendOptions,
): ToolSearchBackendFactory<AiSearchToolSearchBackendStorage> => {
  const namespace = options.namespace ?? "default";
  return {
    namespace,
    pluginStorage: { aiSearchItems },
    storage: (deps): AiSearchToolSearchBackendStorage => ({
      aiSearchItems: deps.pluginStorage.collection(aiSearchItems),
      owner: "org" as const,
    }),
    build: ({ storage }) => {
      const provider = makeAiSearchToolDiscoveryProvider({
        aiSearch: options.aiSearch,
      });
      return {
        namespace,
        provider,
        index: () => unavailableIndex,
        reindex: (executor) =>
          reindexAiSearch({
            executor,
            aiSearch: options.aiSearch,
            items: storage.aiSearchItems,
            owner: storage.owner,
            namespace,
          }),
        reindexBatch: (executor, input) =>
          reindexAiSearchBatch({
            executor,
            aiSearch: options.aiSearch,
            items: storage.aiSearchItems,
            owner: storage.owner,
            namespace,
            ...input,
          }),
        sweep: () =>
          Effect.succeed({
            namespace,
            removed: 0,
          }),
        search: (executor, input): Effect.Effect<SemanticSearchResultPage, SemanticSearchError> =>
          provider
            ? provider
                .searchTools({
                  executor,
                  query: input.query,
                  namespace: input.namespace,
                  limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
                  offset: 0,
                })
                .pipe(
                  Effect.map((page) => ({
                    namespace,
                    query: input.query,
                    items: page.items,
                  })),
                  Effect.mapError(
                    (cause) =>
                      new SemanticSearchError({
                        message: "AI Search query failed.",
                        cause,
                      }),
                  ),
                )
            : notConfigured(),
        status: () =>
          options.aiSearch
            ? statusAiSearch({
                aiSearch: options.aiSearch,
                items: storage.aiSearchItems,
                namespace,
              })
            : notConfigured(),
      };
    },
  };
};
