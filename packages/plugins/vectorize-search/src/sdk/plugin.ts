import { definePlugin, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";

import { makeGeminiEmbedder, type ToolEmbedder } from "./embedder";
import { VectorizeSearchError } from "./errors";
import { reindexToolCatalog, type ReindexResult } from "./indexer";
import { makeVectorizeToolDiscoveryProvider } from "./provider";
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
}

const notConfigured = (): Effect.Effect<never, VectorizeSearchError> =>
  Effect.fail(
    new VectorizeSearchError({
      message:
        "Vectorize search is not configured (missing the Vectorize binding or Gemini API key).",
    }),
  );

/** Build the `executor.vectorizeSearch` surface. `reindex` embeds the current
 *  tool catalog and upserts it into Vectorize; it takes the scoped executor as
 *  an argument because only the request/API layer holds it (the plugin ctx does
 *  not expose the catalog). Inert — `reindex` fails clearly — until both a
 *  Vectorize binding and an embedder are present. */
const makeVectorizeSearchExtension = (deps: {
  readonly namespace: string;
  readonly embedder: ToolEmbedder | undefined;
  readonly store: VectorizeStore | undefined;
}) => ({
  reindex: (executor: Executor): Effect.Effect<ReindexResult, VectorizeSearchError> =>
    deps.embedder && deps.store
      ? reindexToolCatalog({
          namespace: deps.namespace,
          executor,
          embedder: deps.embedder,
          store: deps.store,
        })
      : notConfigured(),
});

/** The `executor.vectorizeSearch` surface, derived from its factory. */
export type VectorizeSearchExtension = ReturnType<typeof makeVectorizeSearchExtension>;

/**
 * Semantic `tools.search` backed by Cloudflare Vectorize + Gemini embeddings.
 * Supplies a `runtime.toolDiscoveryProvider`, so it replaces the engine's
 * built-in lexical scorer wherever it is registered. The tool catalog is
 * indexed explicitly via the `reindex` extension method (see the `/api` subpath
 * for the HTTP route).
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
  const store = options?.vectorize ? makeVectorizeStore(options.vectorize) : undefined;

  return {
    id: "vectorizeSearch" as const,
    packageName: "@executor-js/plugin-vectorize-search",
    storage: () => ({}),
    extension: () => makeVectorizeSearchExtension({ namespace, embedder, store }),
    runtime: {
      toolDiscoveryProvider: () =>
        embedder && store
          ? makeVectorizeToolDiscoveryProvider({ embedder, store, namespace })
          : undefined,
    },
  };
});
