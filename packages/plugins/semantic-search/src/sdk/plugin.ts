import {
  definePlugin,
  type Executor,
  type ToolDiscoveryProvider,
  type ToolDiscoveryResult,
} from "@executor-js/sdk/core";
import { Effect } from "effect";

import { type Chunker, makeFacetChunker } from "./chunker";
import { indexChunks, indexJobs, indexRuns, toolFingerprints } from "./collections";
import { makeGeminiEmbedder, type ToolEmbedder } from "./embedder";
import { SemanticSearchError } from "./errors";
import { makeHybridToolDiscoveryProvider } from "./hybrid";
import {
  make as makeToolSearchIndex,
  run as runToolSearchIndex,
  sweepRemoved,
  type ToolSearchIndex,
} from "./tool-search-index";
import { makeVectorToolDiscoveryProvider } from "./provider";
import type { VectorStore } from "./store";
import { type FtsLexicalStore, makeFtsLexicalProvider } from "./store-fts";

export interface SemanticSearchPluginOptions {
  /** A vector store — construct one with `makeVectorizeStore` (Cloudflare),
   *  `makeZVecStore` (local/dev), or any other `VectorStore` implementation.
   *  Absent → the plugin is inert and the engine keeps its built-in lexical
   *  search, mirroring how the metrics plugin no-ops without its binding. */
  readonly store?: VectorStore;
  /** Gemini API key (a wrangler secret on the Cloudflare host). Absent → inert,
   *  unless a custom `embedder` is supplied. */
  readonly geminiApiKey?: string;
  /** Namespace isolating this tenant's vectors. The single-org self-host passes
   *  its org id; multi-tenant per-request scoping is a follow-up. Defaults to
   *  `"default"`. */
  readonly namespace?: string;
  /** Gemini embedding model id. Defaults to the v2 model (see embedder). */
  readonly model?: string;
  /** Embedding dimensionality — MUST equal the vector index's dimensions. */
  readonly dimensions?: number;
  /** Gemini embedding batch size (texts per request; the Google provider allows
   *  up to 2048 values per call, but Workers memory is the practical ceiling).
   *  Larger batches
   *  mean fewer, fatter requests — lower peak RPM for the same tokens — which is
   *  the key lever when a reindex fans out across many concurrent workers and is
   *  request-rate-bound. Defaults to the embedder's own default. */
  readonly embedderBatchSize?: number;
  /** Inject a custom embedder (tests). Overrides `model`/`geminiApiKey`/`dimensions`. */
  readonly embedder?: ToolEmbedder;
  /** Chunker used when indexing the tool catalog. Defaults to `makeFacetChunker()`.
   *  Override in tests or to benchmark the whole chunker. */
  readonly chunker?: Chunker;
  /** Lexical discovery provider to fuse with the vector provider (RRF). The host
   *  supplies the engine's built-in `defaultToolDiscoveryProvider` here — kept as
   *  an option so the plugin never depends on `@executor-js/execution`. Absent →
   *  the plugin replaces tool search with the vector provider ALONE (the engine's
   *  lexical scorer does NOT run, because a plugin provider supersedes it). Supply
   *  it to get hybrid lexical+vector search. */
  readonly lexical?: ToolDiscoveryProvider;
  /** A populated FTS5 lexical store — e.g. `makeD1FtsLexicalStore(env.DB)` on
   *  Cloudflare, or `makeFtsLexicalStore({ path })` locally. When supplied,
   *  `reindex` ALSO writes each tool's lexical document here, and the store is
   *  wrapped as the hybrid `lexical` provider — giving real FTS5/BM25 + vector
   *  RRF without the host owning lexical indexing. Takes precedence over
   *  `lexical`. */
  readonly lexicalStore?: FtsLexicalStore;
}

const notConfigured = (): Effect.Effect<never, SemanticSearchError> =>
  Effect.fail(
    new SemanticSearchError({
      message: "Semantic search is not configured (missing the vector store or Gemini API key).",
    }),
  );

/** Default page size for the operator `search` surface. */
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_IN_PROCESS_PARTITIONS = 1;

/** A live `tools.search` result page from the operator search surface. */
export interface SemanticSearchResultPage {
  readonly namespace: string;
  readonly query: string;
  readonly items: readonly ToolDiscoveryResult[];
}

/** Operator-facing index status: indexed (vector) + lexical document counts. */
export interface SemanticSearchStatus {
  readonly namespace: string;
  /** Tools with a stored fingerprint — the vector-indexed count. */
  readonly indexed: number;
  /** FTS5 lexical documents, or `null` when no lexical store is configured. */
  readonly lexical: number | null;
}

/** Build the `executor.semanticSearch` surface: `reindex` (reconcile the catalog
 *  into the vector + lexical index), `search` (live `tools.search` through the
 *  shared provider), and `status` (index counts). `reindex`/`search` take the
 *  scoped executor because only the request/API layer holds it. `reindex`/`search`
 *  are inert — failing clearly — until both a vector store and an embedder are
 *  present. */
const makeSemanticSearchExtension = (deps: {
  readonly namespace: string;
  readonly embedder: ToolEmbedder | undefined;
  readonly store: VectorStore | undefined;
  readonly chunker: Chunker;
  readonly fingerprints: Parameters<typeof runToolSearchIndex>[0]["fingerprints"] | undefined;
  readonly indexRuns: Parameters<typeof runToolSearchIndex>[0]["runs"] | undefined;
  readonly indexJobs: Parameters<typeof runToolSearchIndex>[0]["jobs"] | undefined;
  readonly indexChunks: Parameters<typeof runToolSearchIndex>[0]["chunks"] | undefined;
  readonly blobs: Parameters<typeof runToolSearchIndex>[0]["blobs"] | undefined;
  readonly owner: Parameters<typeof runToolSearchIndex>[0]["owner"] | undefined;
  readonly lexicalStore: FtsLexicalStore | undefined;
  readonly provider: ToolDiscoveryProvider | undefined;
}) => {
  const unconfiguredIndex: ToolSearchIndex.Service = {
    create: () => notConfigured(),
    plan: () => notConfigured(),
    chunk: () => notConfigured(),
    embed: () => notConfigured(),
    status: () => notConfigured(),
    complete: () => notConfigured(),
  };
  const index = (executor: Executor): ToolSearchIndex.Service =>
    deps.embedder &&
    deps.store &&
    deps.fingerprints &&
    deps.indexRuns &&
    deps.indexJobs &&
    deps.indexChunks &&
    deps.blobs &&
    deps.owner
      ? makeToolSearchIndex({
          namespace: deps.namespace,
          executor,
          embedder: deps.embedder,
          store: deps.store,
          chunker: deps.chunker,
          runs: deps.indexRuns,
          jobs: deps.indexJobs,
          chunks: deps.indexChunks,
          fingerprints: deps.fingerprints,
          blobs: deps.blobs,
          owner: deps.owner,
          lexicalStore: deps.lexicalStore,
        })
      : unconfiguredIndex;

  return {
    index,
    reindex: (executor: Executor): Effect.Effect<ToolSearchIndex.Result, SemanticSearchError> =>
      deps.embedder &&
      deps.store &&
      deps.fingerprints &&
      deps.indexRuns &&
      deps.indexJobs &&
      deps.indexChunks &&
      deps.blobs &&
      deps.owner
        ? runToolSearchIndex({
            namespace: deps.namespace,
            executor,
            embedder: deps.embedder,
            store: deps.store,
            chunker: deps.chunker,
            runs: deps.indexRuns,
            jobs: deps.indexJobs,
            chunks: deps.indexChunks,
            fingerprints: deps.fingerprints,
            blobs: deps.blobs,
            owner: deps.owner,
            lexicalStore: deps.lexicalStore,
            runId: `manual-${Date.now()}`,
            partitionCount: DEFAULT_IN_PROCESS_PARTITIONS,
          })
        : notConfigured(),

    /** Delete index entries for tools that left the catalog. Needs no embedder. */
    sweep: (
      executor: Executor,
    ): Effect.Effect<
      { readonly namespace: string; readonly removed: number },
      SemanticSearchError
    > =>
      deps.store && deps.fingerprints && deps.owner
        ? sweepRemoved({
            namespace: deps.namespace,
            executor,
            store: deps.store,
            fingerprints: deps.fingerprints,
            owner: deps.owner,
            lexicalStore: deps.lexicalStore,
          })
        : notConfigured(),

    /** Run a live `tools.search` through the same provider the engine uses, so the
     *  operator console sees exactly what the agent would. Inert until configured. */
    search: (
      executor: Executor,
      input: { readonly query: string; readonly namespace?: string; readonly limit?: number },
    ): Effect.Effect<SemanticSearchResultPage, SemanticSearchError> => {
      const namespace = input.namespace ?? deps.namespace;
      return deps.provider
        ? deps.provider
            .searchTools({
              executor,
              query: input.query,
              namespace,
              limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
              offset: 0,
            })
            .pipe(
              Effect.map((page) => ({ namespace, query: input.query, items: page.items })),
              Effect.mapError(
                (cause) =>
                  new SemanticSearchError({ message: "Semantic search query failed.", cause }),
              ),
            )
        : notConfigured();
    },

    /** Index status for the operator console: vector (fingerprint) + lexical counts. */
    status: (): Effect.Effect<SemanticSearchStatus, SemanticSearchError> =>
      Effect.gen(function* () {
        const indexed = deps.fingerprints
          ? yield* deps.fingerprints
              .count()
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new SemanticSearchError({ message: "Failed to count indexed tools.", cause }),
                ),
              )
          : 0;
        // A transient lexical-count failure must not mask the (already-fetched)
        // vector count: degrade `lexical` to null and still return `indexed`.
        const lexical = deps.lexicalStore
          ? yield* deps.lexicalStore
              .count(deps.namespace)
              .pipe(Effect.catch(() => Effect.succeed(null)))
          : null;
        return { namespace: deps.namespace, indexed, lexical };
      }),
  };
};

/** The `executor.semanticSearch` surface, derived from its factory. */
export type SemanticSearchExtension = ReturnType<typeof makeSemanticSearchExtension>;

/**
 * Semantic `tools.search` backed by a vector store + Gemini embeddings.
 * Supplies a `runtime.toolDiscoveryProvider`, so it supersedes the engine's
 * built-in lexical scorer wherever it is registered. The tool catalog is
 * indexed explicitly via the `reindex` extension method (see the `/api` subpath
 * for the HTTP route).
 *
 * When both an embedder and a vector store are present, the plugin exposes a
 * discovery provider. If the host also supplies `lexical`, that provider and the
 * vector provider are fused with Reciprocal Rank Fusion (hybrid search);
 * otherwise the vector provider answers alone.
 */
export const semanticSearchPlugin = definePlugin((options?: SemanticSearchPluginOptions) => {
  const namespace = options?.namespace ?? "default";
  const embedder =
    options?.embedder ??
    (options?.geminiApiKey
      ? makeGeminiEmbedder({
          apiKey: options.geminiApiKey,
          model: options.model,
          dimensions: options.dimensions,
          batchSize: options.embedderBatchSize,
        })
      : undefined);
  // Inert without both a vector store and an embedder — the engine then
  // keeps its built-in lexical search (mirrors the metrics plugin's no-op).
  const store = options?.store;
  const chunker = options?.chunker ?? makeFacetChunker();
  const lexical = options?.lexical;
  const lexicalStore = options?.lexicalStore;

  // Build the discovery provider once and share it between the engine's
  // `tools.search` (runtime) and the operator `search` extension surface, so
  // both answer through exactly the same vector/hybrid path. A populated FTS5
  // store (wrapped as a provider) takes precedence over a host-supplied lexical
  // provider; either side fuses with the vector provider via RRF.
  const provider: ToolDiscoveryProvider | undefined =
    !embedder || !store
      ? undefined
      : (() => {
          const vector = makeVectorToolDiscoveryProvider({ embedder, store, namespace });
          const lexicalProvider = lexicalStore
            ? makeFtsLexicalProvider(lexicalStore, namespace)
            : lexical;
          return lexicalProvider
            ? makeHybridToolDiscoveryProvider({ lexical: lexicalProvider, vector })
            : vector;
        })();

  return {
    id: "semanticSearch" as const,
    packageName: "@executor-js/plugin-semantic-search",
    pluginStorage: { toolFingerprints, indexRuns, indexJobs, indexChunks },
    storage: (deps) => ({
      fingerprints: deps.pluginStorage.collection(toolFingerprints),
      indexRuns: deps.pluginStorage.collection(indexRuns),
      indexJobs: deps.pluginStorage.collection(indexJobs),
      indexChunks: deps.pluginStorage.collection(indexChunks),
      indexBlobs: deps.blobs,
      // The tool catalog is an org-level artifact, so fingerprints are ALWAYS
      // org-scoped. Scoping by the triggering principal (user vs cron) would
      // split the fingerprint store into disjoint partitions, so each reindex
      // would see an empty store and re-embed the whole catalog.
      owner: "org" as const,
    }),
    extension: (ctx) =>
      makeSemanticSearchExtension({
        namespace,
        embedder,
        store,
        chunker,
        fingerprints: ctx.storage.fingerprints,
        indexRuns: ctx.storage.indexRuns,
        indexJobs: ctx.storage.indexJobs,
        indexChunks: ctx.storage.indexChunks,
        blobs: ctx.storage.indexBlobs,
        owner: ctx.storage.owner,
        lexicalStore,
        provider,
      }),
    runtime: {
      toolDiscoveryProvider: () => provider,
    },
  };
});
