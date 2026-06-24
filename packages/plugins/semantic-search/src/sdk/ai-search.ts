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

export interface AiSearchUploadedItem {
  readonly id: string;
  readonly key: string;
}

export interface AiSearchListedItem {
  readonly id: string;
  readonly key: string;
  readonly status: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AiSearchInstance {
  readonly items: {
    readonly upload: (
      name: string,
      content: string | ArrayBuffer | ReadableStream,
      options?: { readonly metadata?: Readonly<Record<string, string>> },
    ) => Promise<AiSearchUploadedItem>;
    readonly list: (input?: {
      readonly page?: number;
      readonly per_page?: number;
      readonly status?: string;
      readonly sort_by?: string;
      readonly search?: string;
      readonly source?: string;
    }) => Promise<{
      readonly result: readonly AiSearchListedItem[];
      readonly result_info?: {
        readonly count?: number;
        readonly total_count?: number;
        readonly page?: number;
        readonly per_page?: number;
      };
    }>;
    readonly delete: (itemId: string) => Promise<void>;
  };
  readonly search: (input: {
    readonly messages: readonly [{ readonly role: "user"; readonly content: string }];
    readonly ai_search_options?: {
      readonly retrieval?: {
        readonly retrieval_type?: "vector" | "keyword" | "hybrid";
        readonly max_num_results?: number;
        readonly metadata_only?: boolean;
        readonly return_on_failure?: boolean;
      };
      readonly reranking?: { readonly enabled?: boolean };
    };
  }) => Promise<AiSearchSearchResponse>;
}

export interface AiSearchChunk {
  readonly id: string;
  readonly score: number;
  readonly text?: string;
  readonly item?: {
    readonly key?: string;
    readonly metadata?: Readonly<Record<string, string>>;
  };
}

export interface AiSearchSearchResponse {
  readonly search_query?: string;
  readonly chunks?: readonly AiSearchChunk[];
}

export interface AiSearchReindexResult {
  readonly namespace: string;
  readonly total: number;
  readonly indexed: number;
  readonly skipped: number;
  readonly removed: number;
}

export interface SemanticSearchStatus {
  readonly namespace: string;
  readonly indexed: number;
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly error: number;
  readonly skipped: number;
  readonly outdated: number;
  readonly lastActivity?: string;
}

type ItemsCollection = PluginStorageCollectionFacade<typeof aiSearchItems>;

const nowIso = (): string => new Date().toISOString();

const toStatus = (status: string | undefined): AiSearchItemStatus =>
  status === "queued" || status === "running" || status === "completed" || status === "error"
    ? status
    : "queued";

const toItemName = (document: ToolSearchDocument): string => `${document.path}.md`;

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

const deleteItem = (aiSearch: AiSearchInstance, itemId: string): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: () => aiSearch.items.delete(itemId),
    catch: () => undefined,
  }).pipe(
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );

const putIndexedItem = (
  items: ItemsCollection,
  owner: "user" | "org",
  document: ToolSearchDocument,
  uploaded: AiSearchUploadedItem,
): Effect.Effect<void, SemanticSearchError> =>
  items
    .put({
      owner,
      key: document.path,
      data: {
        path: document.path,
        key: uploaded.key,
        itemId: uploaded.id,
        name: document.name,
        description: document.description,
        integration: document.integration,
        connection: document.connection,
        plugin: document.plugin,
        fingerprint: document.fingerprint,
        status: "queued",
        updatedAt: nowIso(),
      },
    })
    .pipe(Effect.asVoid, Effect.mapError(mapStorageError("Failed to record AI Search item.")));

export const reindexAiSearch = (input: {
  readonly executor: Executor;
  readonly aiSearch: AiSearchInstance | undefined;
  readonly items: ItemsCollection;
  readonly owner: "user" | "org";
  readonly namespace: string;
  readonly maxTools?: number;
}): Effect.Effect<AiSearchReindexResult, SemanticSearchError> => {
  if (!input.aiSearch) {
    return Effect.fail(
      new SemanticSearchError({
        message: "Semantic search is not configured (missing AI Search).",
      }),
    );
  }
  const aiSearch = input.aiSearch;
  return Effect.gen(function* () {
    const manifests = yield* listToolManifests(input.executor, { maxTools: input.maxTools });
    const livePaths = new Set(manifests.map((manifest) => manifest.path));
    const existingEntries = yield* input.items
      .list()
      .pipe(Effect.mapError(mapStorageError("Failed to list AI Search item rows.")));
    const existingByPath = new Map(existingEntries.map((entry) => [entry.key, entry.data]));
    let indexed = 0;
    let skipped = 0;

    for (const manifest of manifests) {
      const previous = existingByPath.get(manifest.path);
      const fingerprint = toolItemKey(manifest);
      if (previous?.fingerprint === fingerprint) {
        skipped += 1;
        continue;
      }
      const document = yield* collectToolSearchDocument(input.executor, manifest);
      if (previous) {
        yield* deleteItem(aiSearch, previous.itemId);
      }
      const uploaded = yield* Effect.tryPromise({
        try: () =>
          aiSearch.items.upload(toItemName(document), document.content, {
            metadata: document.metadata,
          }),
        catch: mapUploadError(document),
      });
      yield* putIndexedItem(input.items, input.owner, document, uploaded);
      indexed += 1;
    }

    let removed = 0;
    for (const entry of existingEntries) {
      if (livePaths.has(entry.key)) continue;
      yield* deleteItem(aiSearch, entry.data.itemId);
      yield* input.items
        .remove({ owner: input.owner, key: entry.key })
        .pipe(Effect.mapError(mapStorageError("Failed to remove stale AI Search item row.")));
      removed += 1;
    }

    return { namespace: input.namespace, total: manifests.length, indexed, skipped, removed };
  });
};

const listAiSearchItems = (
  aiSearch: AiSearchInstance,
): Effect.Effect<readonly AiSearchListedItem[], SemanticSearchError> =>
  Effect.gen(function* () {
    const all: AiSearchListedItem[] = [];
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

export const statusAiSearch = (input: {
  readonly aiSearch: AiSearchInstance;
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

const chunkToResult = (chunk: AiSearchChunk): ToolDiscoveryResult | null => {
  const metadata = chunk.item?.metadata;
  const path = metadata?.path;
  const name = metadata?.name;
  const integration = metadata?.integration;
  if (!path || !name || !integration) return null;
  return {
    path,
    name,
    description: chunk.text,
    integration,
    score: chunk.score,
  };
};

export const makeAiSearchToolDiscoveryProvider = (deps: {
  readonly aiSearch: AiSearchInstance | undefined;
  readonly items: ItemsCollection | undefined;
  readonly namespace: string;
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

        const rowsByKey =
          deps.items === undefined
            ? new Map<string, AiSearchItemRow>()
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
        const bestByPath = new Map<string, ToolDiscoveryResult>();
        for (const chunk of response.chunks ?? []) {
          const row = chunk.item?.key ? rowsByKey.get(chunk.item.key) : undefined;
          const result = row ? rowToResult(row, chunk.score) : chunkToResult(chunk);
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
