import type { Executor } from "@executor-js/sdk/core";
import type { Owner, PluginStorageCollectionFacade } from "@executor-js/sdk/core";
import { Effect } from "effect";

import type { Chunker } from "./chunker";
import type { FingerprintRow } from "./collections";
import { toolFingerprints } from "./collections";
import { collectToolDocumentInputs } from "./documents";
import type { ToolEmbedder } from "./embedder";
import { VectorizeSearchError } from "./errors";
import { fingerprintTool } from "./fingerprint";
import type { VectorizeStore, VectorizeVectorInput } from "./vectorize";

// ---------------------------------------------------------------------------
// ReconcileResult
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  /** The namespace this reconcile ran against. */
  readonly namespace: string;
  /** Total tools in the live catalog. */
  readonly total: number;
  /** Number of tools whose embeddings were refreshed (new + changed). */
  readonly reembedded: number;
  /** Number of tools whose stored fingerprint matched — skipped entirely. */
  readonly unchanged: number;
  /** Number of tools present in storage but absent from the current catalog
   *  (not deleted in v1 — deletion is unsafe across per-isolate catalog variance;
   *  logged only). */
  readonly removedSkipped: number;
}

// ---------------------------------------------------------------------------
// reconcileToolCatalog — incremental fingerprint-based reindex
// ---------------------------------------------------------------------------

/** Reconcile the live tool catalog against the Vectorize index.
 *
 *  Algorithm:
 *  1. Collect `ToolDocumentInput` for every tool (tools.list + tools.schema).
 *  2. Fingerprint each tool.
 *  3. Load stored `FingerprintRow`s; diff: new ∪ changed → re-embed + upsert.
 *     For CHANGED tools, delete old chunk ids before upserting new.
 *  4. Tools in storage but absent from the live catalog → skip deletion (v1),
 *     count them into `removedSkipped`.
 *  5. Unchanged tools → skip entirely.
 *
 *  The owner parameter is the org-level scope used for all storage writes. */
export const reconcileToolCatalog = (input: {
  readonly namespace: string;
  readonly executor: Executor;
  readonly embedder: ToolEmbedder;
  readonly store: VectorizeStore;
  readonly chunker: Chunker;
  readonly fingerprints: PluginStorageCollectionFacade<typeof toolFingerprints>;
  readonly owner: Owner;
}): Effect.Effect<ReconcileResult, VectorizeSearchError> =>
  Effect.gen(function* () {
    const { namespace, executor, embedder, store, chunker, fingerprints, owner } = input;

    // -------------------------------------------------------------------------
    // Step 1 — Collect tool documents (list + schema).
    // -------------------------------------------------------------------------
    const docs = yield* collectToolDocumentInputs(namespace, executor);
    const total = docs.length;

    if (total === 0) {
      return { namespace, total: 0, reembedded: 0, unchanged: 0, removedSkipped: 0 };
    }

    // -------------------------------------------------------------------------
    // Step 2 — Fingerprint each live tool.
    // -------------------------------------------------------------------------
    const liveByPath = new Map(
      docs.map((doc) => [doc.path, { doc, fingerprint: fingerprintTool(doc) }]),
    );

    // -------------------------------------------------------------------------
    // Step 3 — Load all stored fingerprints.
    // -------------------------------------------------------------------------
    const storedEntries = yield* fingerprints.list().pipe(
      Effect.mapError(
        (cause) =>
          new VectorizeSearchError({
            message: "Failed to load stored fingerprints for reconcile.",
            cause,
          }),
      ),
    );
    const storedByPath = new Map(storedEntries.map((entry) => [entry.key, entry.data]));

    // -------------------------------------------------------------------------
    // Step 4 — Diff: classify each live tool as new, changed, or unchanged.
    // -------------------------------------------------------------------------
    const toEmbed: Array<{
      doc: (typeof docs)[number];
      fingerprint: string;
      oldChunkIds: readonly string[] | null;
    }> = [];
    let unchanged = 0;

    for (const [path, { doc, fingerprint }] of liveByPath) {
      const stored = storedByPath.get(path);
      if (stored !== undefined && stored.fingerprint === fingerprint) {
        unchanged++;
      } else {
        toEmbed.push({
          doc,
          fingerprint,
          oldChunkIds: stored?.chunkIds ?? null,
        });
      }
    }

    // -------------------------------------------------------------------------
    // Step 5 — Count removed (stored but no longer live) — skip deletion in v1.
    // -------------------------------------------------------------------------
    let removedSkipped = 0;
    for (const storedPath of storedByPath.keys()) {
      if (!liveByPath.has(storedPath)) {
        removedSkipped++;
        // Intentionally NOT deleting: per-isolate catalog variance makes
        // deletion unsafe in v1 — log the count so the operator is aware.
      }
    }
    if (removedSkipped > 0) {
      yield* Effect.logWarning(
        `reconcileToolCatalog [${namespace}]: ${removedSkipped} tool(s) present in ` +
          `storage but absent from the live catalog — skipping deletion (v1).`,
      );
    }

    // -------------------------------------------------------------------------
    // Step 6 — Re-embed and upsert changed/new tools.
    // -------------------------------------------------------------------------
    if (toEmbed.length === 0) {
      return { namespace, total, reembedded: 0, unchanged, removedSkipped };
    }

    // Chunk all tools to re-embed.
    const chunkedGroups = toEmbed.map((item) => ({
      ...item,
      chunks: chunker.chunk(namespace, item.doc),
    }));

    // Gather all embedding texts, preserving their group + chunk positions.
    const allTexts: string[] = [];
    for (const group of chunkedGroups) {
      for (const chunk of group.chunks) {
        allTexts.push(chunk.embeddingText);
      }
    }

    // Single batched embedding call over all changed chunks.
    const allVectors = yield* embedder.embedDocuments(allTexts);

    // Build VectorizeVectorInput records and collect new chunkIds per tool.
    let vectorOffset = 0;
    const records: VectorizeVectorInput[] = [];
    const fingerprintUpdates: Array<{ path: string; row: FingerprintRow }> = [];

    for (const group of chunkedGroups) {
      const { doc, fingerprint, oldChunkIds, chunks } = group;
      const newChunkIds: string[] = [];

      for (const chunkItem of chunks) {
        const vec = allVectors[vectorOffset++];
        if (vec === undefined) {
          return yield* new VectorizeSearchError({
            message: `reconcileToolCatalog: embedding vector missing at offset ${vectorOffset - 1}`,
          });
        }
        records.push({
          id: chunkItem.id,
          values: [...vec],
          namespace,
          metadata: {
            path: doc.path,
            name: doc.name,
            description: doc.description,
            integration: doc.integration,
            facet: chunkItem.facet,
            chunkIndex: chunkItem.chunkIndex,
          },
        });
        newChunkIds.push(chunkItem.id);
      }

      fingerprintUpdates.push({
        path: doc.path,
        row: {
          path: doc.path,
          integration: doc.integration,
          fingerprint,
          chunkIds: newChunkIds,
        },
      });

      // Delete OLD chunk ids for changed tools before upserting new ones.
      if (oldChunkIds !== null && oldChunkIds.length > 0) {
        yield* store.deleteByIds([...oldChunkIds]);
      }
    }

    // Upsert all new vectors in one call. `store.upsert` (makeVectorizeStore)
    // chunks internally into UPSERT_BATCH_SIZE (50) sequential batches, so the
    // underlying Vectorize binding never receives more than 50 vectors per
    // call — well under Cloudflare's 1,000-vector / 2 MB per-upsert caps —
    // regardless of how many tools changed.
    yield* store.upsert(records);

    // Persist updated fingerprint rows.
    yield* Effect.forEach(
      fingerprintUpdates,
      ({ path, row }) =>
        fingerprints.put({ owner, key: path, data: row }).pipe(
          Effect.mapError(
            (cause) =>
              new VectorizeSearchError({
                message: `Failed to persist fingerprint row for tool "${path}".`,
                cause,
              }),
          ),
          Effect.asVoid,
        ),
      { concurrency: 8, discard: true },
    );

    return {
      namespace,
      total,
      reembedded: toEmbed.length,
      unchanged,
      removedSkipped,
    };
  });
