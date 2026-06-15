import type { Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";

import { projectToolDocument, type ToolSearchDocument } from "./documents";
import type { ToolEmbedder } from "./embedder";
import { VectorizeSearchError } from "./errors";
import type { VectorizeStore, VectorizeVectorInput } from "./vectorize";

export interface ReindexResult {
  readonly namespace: string;
  readonly indexedToolCount: number;
}

/** Project the whole tool catalog into indexable documents. Lightweight: it
 *  uses only `tools.list` fields (path/name/description/integration) and does
 *  not `describe` each tool, so a reindex is one catalog read + one batched
 *  embedding call rather than N per-tool round-trips. */
export const collectToolDocuments = (
  namespace: string,
  executor: Executor,
): Effect.Effect<readonly ToolSearchDocument[], VectorizeSearchError> =>
  executor.tools.list({ includeAnnotations: false }).pipe(
    Effect.map((tools) => tools.map((tool) => projectToolDocument(namespace, tool))),
    Effect.mapError(
      (cause) => new VectorizeSearchError({ message: "Failed to list tools for indexing.", cause }),
    ),
  );

/** Embed the current tool catalog and upsert it into Vectorize under
 *  `namespace`. Explicit (v1): callers invoke it on demand via the `/api`
 *  reindex route (or a cron). Returns the indexed count. */
export const reindexToolCatalog = (input: {
  readonly namespace: string;
  readonly executor: Executor;
  readonly embedder: ToolEmbedder;
  readonly store: VectorizeStore;
}): Effect.Effect<ReindexResult, VectorizeSearchError> =>
  Effect.gen(function* () {
    const { namespace, executor, embedder, store } = input;
    const documents = yield* collectToolDocuments(namespace, executor);
    if (documents.length === 0) {
      return { namespace, indexedToolCount: 0 };
    }
    const vectors = yield* embedder.embedDocuments(
      documents.map((document) => document.embeddingText),
    );
    const records: readonly VectorizeVectorInput[] = documents.map((document, index) => ({
      id: document.id,
      values: [...(vectors[index] ?? [])],
      namespace,
      metadata: {
        path: document.path,
        name: document.name,
        description: document.description,
        integration: document.integration,
      },
    }));
    yield* store.upsert(records);
    return { namespace, indexedToolCount: records.length };
  });
