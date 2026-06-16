import { definePlugin, type Executor, type ToolDiscoveryProvider } from "@executor-js/sdk/core";
import { Effect } from "effect";

import { type Chunker, makeFacetChunker } from "./chunker";
import { toolFingerprints } from "./collections";
import { makeGeminiEmbedder, type ToolEmbedder } from "./embedder";
import { SemanticSearchError } from "./errors";
import { makeHybridToolDiscoveryProvider } from "./hybrid";
import { reconcileToolCatalog, type ReconcileResult } from "./indexer";
import { makeVectorToolDiscoveryProvider } from "./provider";
import type { VectorStore } from "./store";

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
}

const notConfigured = (): Effect.Effect<never, SemanticSearchError> =>
  Effect.fail(
    new SemanticSearchError({
      message: "Semantic search is not configured (missing the vector store or Gemini API key).",
    }),
  );

/** Build the `executor.semanticSearch` surface. `reindex` reconciles the
 *  current tool catalog incrementally (fingerprint diff) and upserts changed
 *  tools into the vector store; it takes the scoped executor as an argument
 *  because only the request/API layer holds it (the plugin ctx does not expose
 *  the catalog). Inert — `reindex` fails clearly — until both a vector store
 *  and an embedder are present. */
const makeSemanticSearchExtension = (deps: {
  readonly namespace: string;
  readonly embedder: ToolEmbedder | undefined;
  readonly store: VectorStore | undefined;
  readonly chunker: Chunker;
  readonly fingerprints: Parameters<typeof reconcileToolCatalog>[0]["fingerprints"] | undefined;
  readonly owner: Parameters<typeof reconcileToolCatalog>[0]["owner"] | undefined;
}) => ({
  reindex: (executor: Executor): Effect.Effect<ReconcileResult, SemanticSearchError> =>
    deps.embedder && deps.store && deps.fingerprints && deps.owner
      ? reconcileToolCatalog({
          namespace: deps.namespace,
          executor,
          embedder: deps.embedder,
          store: deps.store,
          chunker: deps.chunker,
          fingerprints: deps.fingerprints,
          owner: deps.owner,
        })
      : notConfigured(),
});

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
        })
      : undefined);
  // Inert without both a vector store and an embedder — the engine then
  // keeps its built-in lexical search (mirrors the metrics plugin's no-op).
  const store = options?.store;
  const chunker = options?.chunker ?? makeFacetChunker();
  const lexical = options?.lexical;

  return {
    id: "semanticSearch" as const,
    packageName: "@executor-js/plugin-semantic-search",
    pluginStorage: { toolFingerprints },
    storage: (deps) => ({
      fingerprints: deps.pluginStorage.collection(toolFingerprints),
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
        owner: ctx.storage.owner,
      }),
    runtime: {
      toolDiscoveryProvider: () => {
        if (!embedder || !store) return undefined;
        const vector = makeVectorToolDiscoveryProvider({ embedder, store, namespace });
        // Fuse with the host-supplied lexical provider (RRF) when present; else
        // the vector provider answers alone.
        return lexical ? makeHybridToolDiscoveryProvider({ lexical, vector }) : vector;
      },
    },
  };
});
