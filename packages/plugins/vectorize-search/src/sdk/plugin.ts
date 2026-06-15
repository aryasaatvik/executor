import { definePlugin, type Executor, type ToolDiscoveryProvider } from "@executor-js/sdk/core";
import { Effect } from "effect";

import { type Chunker, makeFacetChunker } from "./chunker";
import { toolFingerprints } from "./collections";
import { makeGeminiEmbedder, type ToolEmbedder } from "./embedder";
import { VectorizeSearchError } from "./errors";
import { makeHybridToolDiscoveryProvider } from "./hybrid";
import { reconcileToolCatalog, type ReconcileResult } from "./indexer";
import { makeVectorizeToolDiscoveryProvider } from "./provider";
import { withCloudflareLimits } from "./store-cloudflare-limits";
import { makeVectorizeStore, type VectorizeIndex, type VectorizeStore } from "./vectorize";

export interface VectorizeSearchPluginOptions {
  /** The Cloudflare Vectorize binding the tool catalog is indexed into. Absent
   *  (binding unbound) → the plugin is inert and the engine keeps its built-in
   *  lexical search, mirroring how the metrics plugin no-ops without its binding. */
  readonly vectorize?: VectorizeIndex;
  /** Gemini API key (a wrangler secret on the Cloudflare host). Absent → inert,
   *  unless a custom `embedder` is supplied. */
  readonly geminiApiKey?: string;
  /** Namespace isolating this tenant's vectors. The single-org self-host passes
   *  its org id; multi-tenant per-request scoping is a follow-up. Defaults to
   *  `"default"`. */
  readonly namespace?: string;
  /** Gemini embedding model id. Defaults to the v2 model (see embedder). */
  readonly model?: string;
  /** Embedding dimensionality — MUST equal the Vectorize index's dimensions. */
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

const notConfigured = (): Effect.Effect<never, VectorizeSearchError> =>
  Effect.fail(
    new VectorizeSearchError({
      message:
        "Vectorize search is not configured (missing the Vectorize binding or Gemini API key).",
    }),
  );

/** Build the `executor.vectorizeSearch` surface. `reindex` reconciles the
 *  current tool catalog incrementally (fingerprint diff) and upserts changed
 *  tools into Vectorize; it takes the scoped executor as an argument because
 *  only the request/API layer holds it (the plugin ctx does not expose the
 *  catalog). Inert — `reindex` fails clearly — until both a Vectorize binding
 *  and an embedder are present. */
const makeVectorizeSearchExtension = (deps: {
  readonly namespace: string;
  readonly embedder: ToolEmbedder | undefined;
  readonly store: VectorizeStore | undefined;
  readonly chunker: Chunker;
  readonly fingerprints: Parameters<typeof reconcileToolCatalog>[0]["fingerprints"] | undefined;
  readonly owner: Parameters<typeof reconcileToolCatalog>[0]["owner"] | undefined;
}) => ({
  reindex: (executor: Executor): Effect.Effect<ReconcileResult, VectorizeSearchError> =>
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

/** The `executor.vectorizeSearch` surface, derived from its factory. */
export type VectorizeSearchExtension = ReturnType<typeof makeVectorizeSearchExtension>;

/**
 * Semantic `tools.search` backed by Cloudflare Vectorize + Gemini embeddings.
 * Supplies a `runtime.toolDiscoveryProvider`, so it supersedes the engine's
 * built-in lexical scorer wherever it is registered. The tool catalog is
 * indexed explicitly via the `reindex` extension method (see the `/api` subpath
 * for the HTTP route).
 *
 * When both an embedder and Vectorize binding are present, the plugin exposes a
 * discovery provider. If the host also supplies `lexical`, that provider and the
 * vector provider are fused with Reciprocal Rank Fusion (hybrid search);
 * otherwise the vector provider answers alone.
 */
export const vectorizeSearchPlugin = definePlugin((options?: VectorizeSearchPluginOptions) => {
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
  // Inert without both a Vectorize binding and an embedder — the engine then
  // keeps its built-in lexical search (mirrors the metrics plugin's no-op).
  // The store is wrapped so Cloudflare's hard limits (64-byte ids, topK ≤ 20
  // with full metadata) fail loudly at the boundary rather than as opaque
  // Vectorize 4xx errors deep in a reindex.
  const store = options?.vectorize
    ? withCloudflareLimits(makeVectorizeStore(options.vectorize))
    : undefined;
  const chunker = options?.chunker ?? makeFacetChunker();
  const lexical = options?.lexical;

  return {
    id: "vectorizeSearch" as const,
    packageName: "@executor-js/plugin-vectorize-search",
    pluginStorage: { toolFingerprints },
    storage: (deps) => ({
      fingerprints: deps.pluginStorage.collection(toolFingerprints),
      owner: deps.owner.subject != null ? ("user" as const) : ("org" as const),
    }),
    extension: (ctx) =>
      makeVectorizeSearchExtension({
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
        const vector = makeVectorizeToolDiscoveryProvider({ embedder, store, namespace });
        // Fuse with the host-supplied lexical provider (RRF) when present; else
        // the vector provider answers alone.
        return lexical ? makeHybridToolDiscoveryProvider({ lexical, vector }) : vector;
      },
    },
  };
});
