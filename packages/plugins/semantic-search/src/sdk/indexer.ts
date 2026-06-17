import type { Executor, Tool } from "@executor-js/sdk/core";
import type { Owner, PluginStorageCollectionFacade } from "@executor-js/sdk/core";
import { Effect } from "effect";

import type { Chunker } from "./chunker";
import type { FingerprintRow } from "./collections";
import { toolFingerprints } from "./collections";
import {
  addressToPath,
  buildLexicalText,
  collectDocsForTools,
  listToolDescriptors,
} from "./documents";
import type { ToolEmbedder } from "./embedder";
import { SemanticSearchError } from "./errors";
import { fingerprintTool } from "./fingerprint";
import type { VectorStore, VectorInput } from "./store";
import type { FtsDocumentInput, FtsLexicalStore } from "./store-fts";

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  /** The namespace this reconcile ran against. */
  readonly namespace: string;
  /** Total tools in the live catalog. */
  readonly total: number;
  /** Number of tools whose embeddings were refreshed (new + changed). */
  readonly reembedded: number;
  /** Number of tools whose stored fingerprint matched — skipped re-embedding. */
  readonly unchanged: number;
  /** Number of tools removed from the index because they left the catalog. */
  readonly removed: number;
}

export interface ReconcilePageResult {
  readonly namespace: string;
  /** Total tools in the live catalog (size of the sorted descriptor list). */
  readonly total: number;
  /** Tools handled in this page. */
  readonly processed: number;
  readonly reembedded: number;
  readonly unchanged: number;
  /** Index of the next page, or `null` when the catalog is exhausted. */
  readonly nextCursor: number | null;
}

export interface SweepResult {
  readonly namespace: string;
  /** Tools deleted from the index (vector chunks + lexical doc + fingerprint). */
  readonly removed: number;
}

/** Default tools-per-page. Bounds the CPU-heavy schema→TS codegen + embedding so
 *  one page fits within a single Worker invocation's CPU budget. */
export const DEFAULT_REINDEX_PAGE_SIZE = 200;

interface ReconcileStores {
  readonly namespace: string;
  readonly executor: Executor;
  readonly store: VectorStore;
  readonly fingerprints: PluginStorageCollectionFacade<typeof toolFingerprints>;
  readonly owner: Owner;
  /** Optional FTS5 lexical store kept in lockstep with the vector index. */
  readonly lexicalStore?: FtsLexicalStore;
}

interface ReconcileDeps extends ReconcileStores {
  readonly embedder: ToolEmbedder;
  readonly chunker: Chunker;
}

// ---------------------------------------------------------------------------
// reconcileToolCatalogPage — reconcile ONE bounded slice of the catalog
// ---------------------------------------------------------------------------

/** Reconcile a single page of the live tool catalog into the vector + lexical
 *  index, returning the cursor for the next page.
 *
 *  `tools.list` has no native pagination, so a page re-lists the (stably sorted)
 *  catalog — cheap, descriptors only — and slices `[cursor, cursor + pageSize)`.
 *  Only the slice pays the CPU-heavy `tools.schema` codegen + embedding, so each
 *  page stays within one invocation's CPU budget. This is the unit a durable
 *  driver (e.g. a Cloudflare Workflow step) calls in a loop; removal of tools
 *  that left the catalog is handled separately by `sweepRemoved`.
 *
 *  Pass a pre-listed `descriptors` snapshot to reuse one catalog read across an
 *  in-process page loop (see `reconcileToolCatalog`); omit it and the page reads
 *  the catalog itself (the durable-step path, where each step is its own read).
 *
 *  NOTE: the schema → TS codegen runs for EVERY tool in the slice, including
 *  fingerprint-unchanged ones, because the fingerprint is derived from the
 *  schema — a schema-only change can't be detected without fetching it. So
 *  per-page CPU is dominated by codegen and is similar on re-runs; the
 *  incremental win is skipping the EMBEDDING of unchanged tools, not their
 *  schema fetch. */
export const reconcileToolCatalogPage = (
  input: ReconcileDeps & {
    readonly cursor: number;
    readonly pageSize?: number;
    readonly descriptors?: readonly Tool[];
  },
): Effect.Effect<ReconcilePageResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const { namespace, executor, embedder, store, chunker, fingerprints, owner } = input;
    const pageSize = input.pageSize ?? DEFAULT_REINDEX_PAGE_SIZE;
    const cursor = Math.max(0, input.cursor);

    const all = input.descriptors ?? (yield* listToolDescriptors(executor));
    const total = all.length;
    const slice = all.slice(cursor, cursor + pageSize);
    const nextCursor = cursor + slice.length < total ? cursor + slice.length : null;

    if (slice.length === 0) {
      return { namespace, total, processed: 0, reembedded: 0, unchanged: 0, nextCursor };
    }

    // Collect docs (schema → TS) for THIS slice only.
    const docs = yield* collectDocsForTools(executor, slice);

    // Lexical store carries no embedding cost, so rebuild it in full for the
    // slice every page (delete-then-insert keyed by namespace-prefixed id).
    if (input.lexicalStore) {
      const lexicalDocs: readonly FtsDocumentInput[] = docs.map((doc) => ({
        id: `${namespace}:${doc.path}`,
        namespace,
        path: doc.path,
        name: doc.name,
        description: doc.description,
        integration: doc.integration,
        lexicalText: buildLexicalText(doc),
      }));
      yield* input.lexicalStore.upsert(lexicalDocs);
    }

    // Load stored fingerprints for just this slice's paths (not the whole index).
    const slicePaths = docs.map((doc) => doc.path);
    const storedByPath = yield* loadFingerprintsForPaths(fingerprints, owner, slicePaths);

    // Diff: classify each tool in the slice as new/changed (re-embed) or unchanged.
    const toEmbed: Array<{
      doc: (typeof docs)[number];
      fingerprint: string;
      oldChunkIds: readonly string[] | null;
    }> = [];
    let unchanged = 0;
    for (const doc of docs) {
      const fingerprint = fingerprintTool(doc);
      const stored = storedByPath.get(doc.path);
      if (stored !== undefined && stored.fingerprint === fingerprint) {
        unchanged++;
      } else {
        toEmbed.push({ doc, fingerprint, oldChunkIds: stored?.chunkIds ?? null });
      }
    }

    if (toEmbed.length === 0) {
      return { namespace, total, processed: slice.length, reembedded: 0, unchanged, nextCursor };
    }

    yield* embedAndUpsert({ namespace, embedder, store, chunker, fingerprints, owner }, toEmbed);

    return {
      namespace,
      total,
      processed: slice.length,
      reembedded: toEmbed.length,
      unchanged,
      nextCursor,
    };
  });

// ---------------------------------------------------------------------------
// sweepRemoved — delete tools that left the catalog
// ---------------------------------------------------------------------------

/** Delete index entries for tools no longer present in the live catalog.
 *
 *  Uses the cheap `listToolDescriptors` (paths only — no schema codegen) for
 *  liveness and diffs it against all stored fingerprints, so it fits one
 *  invocation regardless of catalog size. For each removed tool it deletes the
 *  vector chunks, the lexical document, and the fingerprint row. Guards against
 *  an empty live list (a transient `tools.list` failure must not wipe the index).
 *  Accepts a pre-listed `descriptors` snapshot to share one catalog read with a
 *  preceding in-process page loop. */
export const sweepRemoved = (
  input: ReconcileStores & { readonly descriptors?: readonly Tool[] },
): Effect.Effect<SweepResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const { namespace, executor, store, fingerprints, owner } = input;

    const live = input.descriptors ?? (yield* listToolDescriptors(executor));
    // Safety: never treat an empty live catalog as "everything removed".
    if (live.length === 0) {
      return { namespace, removed: 0 };
    }
    const livePaths = new Set(live.map((tool) => addressToPath(String(tool.address))));

    const storedEntries = yield* fingerprints.list().pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: "Failed to load stored fingerprints for sweep.",
            cause,
          }),
      ),
    );
    const removed = storedEntries.filter((entry) => !livePaths.has(entry.key));
    if (removed.length === 0) {
      return { namespace, removed: 0 };
    }

    yield* Effect.forEach(
      removed,
      (entry) =>
        Effect.gen(function* () {
          const { key: path, data } = entry;
          if (data.chunkIds.length > 0) {
            yield* store.deleteByIds([...data.chunkIds]);
          }
          if (input.lexicalStore) {
            yield* input.lexicalStore.deleteByIds([`${namespace}:${path}`]);
          }
          yield* fingerprints.remove({ owner, key: path }).pipe(
            Effect.mapError(
              (cause) =>
                new SemanticSearchError({
                  message: `Failed to delete fingerprint row for removed tool "${path}".`,
                  cause,
                }),
            ),
          );
        }),
      { concurrency: 8, discard: true },
    );

    return { namespace, removed: removed.length };
  });

// ---------------------------------------------------------------------------
// reconcileToolCatalog — full reconcile (loop pages + sweep)
// ---------------------------------------------------------------------------

/** Reconcile the entire live tool catalog into the vector + lexical index.
 *
 *  Drives `reconcileToolCatalogPage` over every page in-process, then runs
 *  `sweepRemoved`. This is the convenience entry for hosts that can complete the
 *  whole reconcile in one execution (local / self-host, or small catalogs). At
 *  large catalog sizes on a CPU-bounded host (a Worker), drive the page +
 *  sweep primitives from a durable scheduler instead so each step gets its own
 *  CPU budget. */
export const reconcileToolCatalog = (
  input: ReconcileDeps & { readonly pageSize?: number },
): Effect.Effect<ReconcileResult, SemanticSearchError> =>
  Effect.gen(function* () {
    // One catalog snapshot for the whole in-process run: avoids N+1 `tools.list`
    // round-trips across pages + sweep, and gives a consistent `total` and diff
    // even if the catalog changes mid-run. (The durable-step path re-lists per
    // step by design, since each step is a separate invocation.)
    const descriptors = yield* listToolDescriptors(input.executor);
    const total = descriptors.length;
    let cursor = 0;
    let reembedded = 0;
    let unchanged = 0;

    for (;;) {
      const page = yield* reconcileToolCatalogPage({ ...input, cursor, descriptors });
      reembedded += page.reembedded;
      unchanged += page.unchanged;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    const swept = yield* sweepRemoved({ ...input, descriptors });

    return { namespace: input.namespace, total, reembedded, unchanged, removed: swept.removed };
  });

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Load stored fingerprint rows for a specific set of paths (one page), keyed by
 *  path. Avoids loading the whole fingerprint store per page. */
const loadFingerprintsForPaths = (
  fingerprints: PluginStorageCollectionFacade<typeof toolFingerprints>,
  owner: Owner,
  paths: readonly string[],
): Effect.Effect<ReadonlyMap<string, FingerprintRow>, SemanticSearchError> =>
  Effect.forEach(
    paths,
    (path) =>
      fingerprints
        .getForOwner({ owner, key: path })
        .pipe(Effect.map((entry) => [path, entry?.data ?? null] as const)),
    { concurrency: 16 },
  ).pipe(
    Effect.map(
      (pairs) =>
        new Map(pairs.flatMap(([path, data]) => (data === null ? [] : [[path, data] as const]))),
    ),
    Effect.mapError(
      (cause) => new SemanticSearchError({ message: "Failed to load stored fingerprints.", cause }),
    ),
  );

/** Embed the new/changed tools of a page, upsert their vectors (deleting any old
 *  chunks first), and persist their fingerprint rows. */
const embedAndUpsert = (
  deps: {
    readonly namespace: string;
    readonly embedder: ToolEmbedder;
    readonly store: VectorStore;
    readonly chunker: Chunker;
    readonly fingerprints: PluginStorageCollectionFacade<typeof toolFingerprints>;
    readonly owner: Owner;
  },
  toEmbed: ReadonlyArray<{
    readonly doc: {
      readonly path: string;
      readonly name: string;
      readonly description: string;
      readonly integration: string;
    };
    readonly fingerprint: string;
    readonly oldChunkIds: readonly string[] | null;
  }>,
): Effect.Effect<void, SemanticSearchError> =>
  Effect.gen(function* () {
    const { namespace, embedder, store, chunker, fingerprints, owner } = deps;

    const chunkedGroups = toEmbed.map((item) => ({
      ...item,
      chunks: chunker.chunk(namespace, item.doc),
    }));

    const allTexts: string[] = [];
    for (const group of chunkedGroups) {
      for (const chunk of group.chunks) {
        allTexts.push(chunk.embeddingText);
      }
    }

    const allVectors = yield* embedder.embedDocuments(allTexts);

    let vectorOffset = 0;
    const records: VectorInput[] = [];
    const fingerprintUpdates: Array<{ path: string; row: FingerprintRow }> = [];

    for (const group of chunkedGroups) {
      const { doc, fingerprint, oldChunkIds, chunks } = group;
      const newChunkIds: string[] = [];

      for (const chunkItem of chunks) {
        const vec = allVectors[vectorOffset++];
        if (vec === undefined) {
          return yield* new SemanticSearchError({
            message: `reconcileToolCatalogPage: embedding vector missing at offset ${vectorOffset - 1}`,
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
        row: { path: doc.path, integration: doc.integration, fingerprint, chunkIds: newChunkIds },
      });

      // Delete OLD chunk ids for changed tools before upserting new ones.
      if (oldChunkIds !== null && oldChunkIds.length > 0) {
        yield* store.deleteByIds([...oldChunkIds]);
      }
    }

    // `store.upsert` chunks internally (≤50/batch) so the Vectorize binding never
    // exceeds Cloudflare's per-upsert caps regardless of page size.
    yield* store.upsert(records);

    yield* Effect.forEach(
      fingerprintUpdates,
      ({ path, row }) =>
        fingerprints.put({ owner, key: path, data: row }).pipe(
          Effect.mapError(
            (cause) =>
              new SemanticSearchError({
                message: `Failed to persist fingerprint row for tool "${path}".`,
                cause,
              }),
          ),
          Effect.asVoid,
        ),
      { concurrency: 8, discard: true },
    );
  });
