import {
  type Executor,
  type PluginBlobStore,
  type PluginStorageConfig,
  type PluginStorageCollectionFacade,
  type StorageDeps,
  type ToolDiscoveryProvider,
  type ToolDiscoveryResult,
} from "@executor-js/sdk/core";
import { Effect } from "effect";

import { type Chunker, makeFacetChunker } from "./chunker";
import { indexChunks, indexJobs, indexRuns, toolFingerprints } from "./collections";
import { makeGeminiEmbedder, type GeminiEmbedderOptions, type ToolEmbedder } from "./embedder";
import { SemanticSearchError } from "./errors";
import { makeHybridToolDiscoveryProvider } from "./hybrid";
import { makeVectorToolDiscoveryProvider } from "./provider";
import type { VectorStore } from "./store";
import { type FtsLexicalStore, makeFtsLexicalProvider } from "./store-fts";
import {
  make as makeToolSearchIndex,
  run as runToolSearchIndex,
  sweepRemoved,
  type ToolSearchIndex,
} from "./tool-search-index";

export interface SemanticSearchResultPage {
  readonly namespace: string;
  readonly query: string;
  readonly items: readonly ToolDiscoveryResult[];
}

export interface SemanticSearchStatus {
  readonly namespace: string;
  readonly indexed: number;
  readonly lexical: number | null;
}

export interface SemanticSearchRefreshResult {
  readonly namespace: string;
  readonly total: number;
  readonly indexed: number;
  readonly skipped: number;
  readonly removed: number;
}

export interface ToolSearchBackend {
  readonly namespace: string;
  readonly provider?: ToolDiscoveryProvider;
  readonly index: (executor: Executor) => ToolSearchIndex.Service;
  readonly reindex: (
    executor: Executor,
  ) => Effect.Effect<SemanticSearchRefreshResult, SemanticSearchError>;
  readonly sweep: (executor: Executor) => Effect.Effect<
    {
      readonly namespace: string;
      readonly removed: number;
    },
    SemanticSearchError
  >;
  readonly search: (
    executor: Executor,
    input: { readonly query: string; readonly namespace?: string; readonly limit?: number },
  ) => Effect.Effect<SemanticSearchResultPage, SemanticSearchError>;
  readonly status: () => Effect.Effect<SemanticSearchStatus, SemanticSearchError>;
}

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_IN_PROCESS_PARTITIONS = 1;

export interface VectorToolSearchBackendStorage {
  readonly fingerprints: PluginStorageCollectionFacade<typeof toolFingerprints>;
  readonly indexRuns: PluginStorageCollectionFacade<typeof indexRuns>;
  readonly indexJobs: PluginStorageCollectionFacade<typeof indexJobs>;
  readonly indexChunks: PluginStorageCollectionFacade<typeof indexChunks>;
  readonly indexBlobs: PluginBlobStore;
  readonly owner: "org" | "user";
}

export interface ToolSearchBackendFactory<TStorage = unknown> {
  readonly namespace: string;
  readonly pluginStorage?: PluginStorageConfig;
  readonly storage: (deps: StorageDeps) => TStorage;
  build(input: { readonly storage: TStorage }): ToolSearchBackend;
}

export interface VectorToolSearchBackendOptions {
  readonly namespace?: string;
  readonly store: VectorStore;
  readonly geminiApiKey?: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly embedderBatchSize?: number;
  readonly embedder?: ToolEmbedder;
  readonly chunker?: Chunker;
  readonly lexical?: ToolDiscoveryProvider;
  readonly lexicalStore?: FtsLexicalStore;
}

export const notConfigured = (): Effect.Effect<never, SemanticSearchError> =>
  Effect.fail(
    new SemanticSearchError({
      message: "Semantic search is not configured (missing a tool-search backend).",
    }),
  );

export const unconfiguredIndex: ToolSearchIndex.Service = {
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

const makeVectorEmbedder = (options: VectorToolSearchBackendOptions): ToolEmbedder | undefined =>
  options.embedder ??
  (options.geminiApiKey
    ? makeGeminiEmbedder({
        apiKey: options.geminiApiKey,
        model: options.model,
        dimensions: options.dimensions,
        batchSize: options.embedderBatchSize,
      } satisfies GeminiEmbedderOptions)
    : undefined);

const makeVectorProvider = (input: {
  readonly namespace: string;
  readonly embedder: ToolEmbedder | undefined;
  readonly store: VectorStore;
  readonly lexical?: ToolDiscoveryProvider;
  readonly lexicalStore?: FtsLexicalStore;
}): ToolDiscoveryProvider | undefined => {
  if (!input.embedder) return undefined;
  const vector = makeVectorToolDiscoveryProvider({
    embedder: input.embedder,
    store: input.store,
    namespace: input.namespace,
  });
  const lexicalProvider = input.lexicalStore
    ? makeFtsLexicalProvider(input.lexicalStore, input.namespace)
    : input.lexical;
  return lexicalProvider
    ? makeHybridToolDiscoveryProvider({ lexical: lexicalProvider, vector })
    : vector;
};

export const makeVectorToolSearchBackend = (
  options: VectorToolSearchBackendOptions,
): ToolSearchBackendFactory<VectorToolSearchBackendStorage> => {
  const namespace = options.namespace ?? "default";
  const embedder = makeVectorEmbedder(options);
  const chunker = options.chunker ?? makeFacetChunker();
  const provider = makeVectorProvider({
    namespace,
    embedder,
    store: options.store,
    lexical: options.lexical,
    lexicalStore: options.lexicalStore,
  });

  return {
    namespace,
    pluginStorage: { toolFingerprints, indexRuns, indexJobs, indexChunks },
    storage: (deps): VectorToolSearchBackendStorage => ({
      fingerprints: deps.pluginStorage.collection(toolFingerprints),
      indexRuns: deps.pluginStorage.collection(indexRuns),
      indexJobs: deps.pluginStorage.collection(indexJobs),
      indexChunks: deps.pluginStorage.collection(indexChunks),
      indexBlobs: deps.blobs,
      // The tool catalog is an org-level artifact, so fingerprints are ALWAYS
      // org-scoped. Scoping by the triggering principal would split the
      // fingerprint store into disjoint partitions.
      owner: "org" as const,
    }),
    build: ({ storage }) => {
      const index = (executor: Executor): ToolSearchIndex.Service =>
        embedder && provider
          ? makeToolSearchIndex({
              namespace,
              executor,
              embedder,
              store: options.store,
              chunker,
              runs: storage.indexRuns,
              jobs: storage.indexJobs,
              chunks: storage.indexChunks,
              fingerprints: storage.fingerprints,
              blobs: storage.indexBlobs,
              owner: storage.owner,
              lexicalStore: options.lexicalStore,
            })
          : unconfiguredIndex;

      return {
        namespace,
        provider,
        index,
        reindex: (executor) =>
          embedder
            ? runToolSearchIndex({
                namespace,
                executor,
                embedder,
                store: options.store,
                chunker,
                runs: storage.indexRuns,
                jobs: storage.indexJobs,
                chunks: storage.indexChunks,
                fingerprints: storage.fingerprints,
                blobs: storage.indexBlobs,
                owner: storage.owner,
                lexicalStore: options.lexicalStore,
                runId: `manual-${Date.now()}`,
                partitionCount: DEFAULT_IN_PROCESS_PARTITIONS,
              })
            : notConfigured(),
        sweep: (executor) =>
          sweepRemoved({
            namespace,
            executor,
            store: options.store,
            fingerprints: storage.fingerprints,
            blobs: storage.indexBlobs,
            owner: storage.owner,
            lexicalStore: options.lexicalStore,
          }),
        search: (_executor, input) =>
          provider
            ? provider
                .searchTools({
                  executor: _executor,
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
                      new SemanticSearchError({ message: "Semantic search query failed.", cause }),
                  ),
                )
            : notConfigured(),
        status: () =>
          Effect.gen(function* () {
            const indexed = yield* storage.fingerprints
              .count()
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new SemanticSearchError({ message: "Failed to count indexed tools.", cause }),
                ),
              );
            const lexical = options.lexicalStore
              ? yield* options.lexicalStore
                  .count(namespace)
                  .pipe(Effect.catch(() => Effect.succeed(null)))
              : null;
            return { namespace, indexed, lexical };
          }),
      };
    },
  };
};

export const ToolSearchBackend = {
  vector: makeVectorToolSearchBackend,
} as const;
