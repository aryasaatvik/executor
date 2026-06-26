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
import { Effect } from "effect";

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
  readonly aiSearch: Pick<AiSearchInstance, "items" | "search"> | undefined;
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

const nowIso = (): string => new Date().toISOString();

const toStatus = (status: string | undefined): AiSearchItemStatus =>
  status === "queued" || status === "running" || status === "completed" || status === "error"
    ? status
    : "queued";

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
      new SemanticSearchError({ message: `Failed to delete AI Search item "${itemId}".`, cause }),
  }).pipe(Effect.asVoid);

const deleteItemBestEffort = (
  aiSearch: Pick<AiSearchInstance, "items">,
  itemId: string,
): Effect.Effect<void, never> => deleteItem(aiSearch, itemId).pipe(Effect.catch(() => Effect.void));

function listAiSearchItems(
  aiSearch: Pick<AiSearchInstance, "items">,
): Effect.Effect<readonly AiSearchItemInfo[], SemanticSearchError> {
  return Effect.gen(function* () {
    const all: AiSearchItemInfo[] = [];
    let page = 1;
    while (true) {
      const result = yield* Effect.tryPromise({
        try: () => aiSearch.items.list({ page, per_page: 50 }),
        catch: (cause) =>
          new SemanticSearchError({ message: "Failed to list AI Search items.", cause }),
      });
      all.push(...result.result);
      const info = result.result_info;
      const total = info?.total_count;
      const perPage = info?.per_page ?? 50;
      if (total !== undefined ? all.length >= total : result.result.length < perPage) break;
      page += 1;
    }
    return all;
  });
}

const toIndexedItemRow = (
  document: ToolSearchDocument,
  uploaded: AiSearchItemInfo,
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
});

interface UploadedDocument {
  readonly deleteOnStorageFailure: boolean;
  readonly previousItemId?: string;
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
    if (remote !== undefined && remote.status !== "error") {
      return {
        deleteOnStorageFailure: false,
        uploadedItemId: remote.id,
        key: document.path,
        row: toIndexedItemRow(document, remote),
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

    return {
      deleteOnStorageFailure: true,
      ...(previous !== undefined && previous.key !== itemName
        ? { previousItemId: previous.itemId }
        : {}),
      uploadedItemId: uploaded.id,
      key: document.path,
      row: toIndexedItemRow(document, uploaded),
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
    const manifests = yield* listToolManifests(input.executor, { maxTools: batch.maxTools });
    const page = manifests.slice(batch.offset, batch.offset + batch.pageSize);
    const nextOffset =
      batch.offset + page.length < manifests.length ? batch.offset + page.length : null;
    const livePaths = new Set(manifests.map((manifest) => manifest.path));
    const existingEntries = yield* input.items
      .list()
      .pipe(Effect.mapError(mapStorageError("Failed to list AI Search item rows.")));
    const existingByPath = new Map(existingEntries.map((entry) => [entry.key, entry.data]));
    const remoteByKey = new Map(
      (yield* listAiSearchItems(aiSearch)).map((item) => [item.key, item]),
    );
    let skipped = 0;
    const changed: {
      readonly manifest: (typeof manifests)[number];
      readonly previous?: AiSearchItemRow;
    }[] = [];

    for (const manifest of page) {
      const previous = existingByPath.get(manifest.path);
      const fingerprint = toolItemKey(manifest);
      const remote = previous === undefined ? undefined : remoteByKey.get(previous.key);
      if (
        previous?.fingerprint === fingerprint &&
        remote !== undefined &&
        remote.status !== "error"
      ) {
        skipped += 1;
        continue;
      }
      changed.push({
        manifest,
        ...(previous === undefined ? {} : { previous }),
      });
    }

    const uploaded = yield* Effect.forEach(
      changed,
      ({ manifest, previous }) =>
        collectToolSearchDocument(input.executor, manifest).pipe(
          Effect.flatMap((document) =>
            uploadDocument(aiSearch, document, previous, remoteByKey.get(toItemName(document))),
          ),
        ),
      { concurrency: AI_SEARCH_UPLOAD_CONCURRENCY },
    );

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

      yield* Effect.forEach(
        uploaded,
        (entry) =>
          entry.previousItemId === undefined
            ? Effect.void
            : deleteItemBestEffort(aiSearch, entry.previousItemId),
        { concurrency: AI_SEARCH_UPLOAD_CONCURRENCY, discard: true },
      );
    }

    const removedEntries =
      batch.maxTools === undefined && nextOffset === null
        ? existingEntries.filter((entry) => !livePaths.has(entry.key))
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
      skipped += result.skipped;
      removed += result.removed;
      nextOffset = result.nextOffset;
    }

    return {
      namespace: input.namespace,
      total,
      indexed,
      skipped,
      removed,
    };
  });

export const statusAiSearch = (input: {
  readonly aiSearch: Pick<AiSearchInstance, "items">;
  readonly items: ItemsCollection;
  readonly namespace: string;
}): Effect.Effect<SemanticSearchStatus, SemanticSearchError> =>
  Effect.gen(function* () {
    const [rows, aiItems] = yield* Effect.all(
      [
        input.items.list().pipe(Effect.mapError(mapStorageError("Failed to list AI Search rows."))),
        listAiSearchItems(input.aiSearch),
      ] as const,
      { concurrency: 2 },
    );
    const aiByKey = new Map(aiItems.map((item) => [item.key, item]));
    const counts = {
      queued: 0,
      running: 0,
      completed: 0,
      error: 0,
      skipped: 0,
      outdated: 0,
    };
    let lastActivity: string | undefined;
    for (const row of rows) {
      const remote = aiByKey.get(row.data.key);
      const status = remote?.status;
      if (status === "skipped") {
        counts.skipped += 1;
      } else if (status === "outdated") {
        counts.outdated += 1;
      } else {
        counts[toStatus(status)] += 1;
      }
      if (!lastActivity || row.data.updatedAt > lastActivity) lastActivity = row.data.updatedAt;
    }
    return {
      namespace: input.namespace,
      indexed: rows.length,
      lexical: null,
      ...counts,
      ...(lastActivity ? { lastActivity } : {}),
    };
  });

const matchesNamespace = (path: string, namespace: string | undefined): boolean =>
  !namespace || path === namespace || path.startsWith(`${namespace}.`);

const rowToResult = (row: AiSearchItemRow, score: number): ToolDiscoveryResult => ({
  path: row.path,
  name: row.name,
  description: row.description,
  integration: row.integration,
  score,
});

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
  readonly items: ItemsCollection | undefined;
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
        const limit = Math.min(50, Math.max(1, input.limit + input.offset));
        const hasLocalRows = deps.items !== undefined;
        const rowsByKey =
          deps.items === undefined
            ? undefined
            : yield* deps.items.list().pipe(
                Effect.map((rows) => new Map(rows.map((row) => [row.data.key, row.data]))),
                Effect.mapError(
                  (cause) =>
                    new ExecutionToolError({
                      message: "AI Search tool search failed.",
                      cause,
                    }),
                ),
              );
        if (hasLocalRows && rowsByKey?.size === 0) {
          return { items: [], total: 0, hasMore: false, nextOffset: null };
        }
        const response = yield* Effect.tryPromise({
          try: () =>
            aiSearch.search({
              messages: [{ role: "user", content: query }],
              ai_search_options: {
                retrieval: {
                  retrieval_type: "hybrid",
                  max_num_results: limit,
                  return_on_failure: true,
                },
                reranking: { enabled: true },
              },
            }),
          catch: (cause) =>
            new ExecutionToolError({ message: "AI Search tool search failed.", cause }),
        });

        const bestByPath = new Map<string, ToolDiscoveryResult>();
        for (const chunk of response.chunks ?? []) {
          const row = chunk.item?.key ? rowsByKey?.get(chunk.item.key) : undefined;
          const result = row
            ? rowToResult(row, chunk.score)
            : hasLocalRows
              ? null
              : chunkToResult(chunk);
          if (!result || !matchesNamespace(result.path, input.namespace)) continue;
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
        items: storage.aiSearchItems,
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
                      new SemanticSearchError({ message: "AI Search query failed.", cause }),
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
