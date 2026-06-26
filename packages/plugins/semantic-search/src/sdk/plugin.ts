import { definePlugin, type Executor } from "@executor-js/sdk/core";
import type { Effect } from "effect";

import { indexChunks, indexJobs, indexRuns, toolFingerprints } from "./collections";
import type { SemanticSearchError } from "./errors";
import {
  notConfigured,
  type SemanticSearchResultPage,
  type SemanticSearchStatus,
  type ToolSearchBackend,
  type ToolSearchBackendFactory,
  unconfiguredIndex,
} from "./tool-search-backend";

export interface SemanticSearchPluginOptions {
  readonly backend?: ToolSearchBackendFactory;
}

export const makeSemanticSearchExtension = (deps: {
  readonly backend: ToolSearchBackend | undefined;
}) => ({
  index: (executor: Executor) => deps.backend?.index(executor) ?? unconfiguredIndex,
  reindex: (executor: Executor) => deps.backend?.reindex(executor) ?? notConfigured(),
  sweep: (executor: Executor) => deps.backend?.sweep(executor) ?? notConfigured(),
  search: (
    executor: Executor,
    input: { readonly query: string; readonly namespace?: string; readonly limit?: number },
  ): Effect.Effect<SemanticSearchResultPage, SemanticSearchError> =>
    deps.backend?.search(executor, input) ?? notConfigured(),
  status: (): Effect.Effect<SemanticSearchStatus, SemanticSearchError> =>
    deps.backend?.status() ?? notConfigured(),
  provider: deps.backend?.provider,
});

/** The `executor.semanticSearch` surface, derived from its factory. */
export type SemanticSearchExtension = ReturnType<typeof makeSemanticSearchExtension>;

/**
 * Semantic `tools.search` backed by a host-selected search backend.
 * The backend owns indexing, querying, and optional runtime discovery. When it
 * exposes a `provider`, the engine uses it in place of the built-in lexical
 * scorer. Without a backend, the plugin remains registered for stable API shape
 * and fails explicit semantic-search calls with a typed configuration error.
 */
export const semanticSearchPlugin = definePlugin((options?: SemanticSearchPluginOptions) => {
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
        backend: options?.backend?.build({ storage: ctx.storage }),
      }),
    runtime: {
      toolDiscoveryProvider: (extension: SemanticSearchExtension) => extension.provider,
    },
  };
});
