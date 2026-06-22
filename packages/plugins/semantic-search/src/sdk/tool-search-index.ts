import type {
  Executor,
  Owner,
  PluginBlobStore,
  PluginStorageCollectionFacade,
  ToolSchemaManifest,
} from "@executor-js/sdk/core";
import { sha256Hex } from "@executor-js/sdk/core";
import { Context, Effect, Option, Predicate, Schema } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";

import { type Chunker, type ToolChunk, ToolDocumentInput } from "./chunker";
import {
  type FingerprintRow,
  type IndexChunk,
  type IndexJob,
  type IndexRun,
  indexChunks,
  indexJobs,
  indexRuns,
  toolFingerprints,
} from "./collections";
import {
  addressToPath,
  buildLexicalText,
  collectDocForTool,
  type IndexableToolDescriptor,
  listToolDescriptors,
  listToolManifests,
} from "./documents";
import type { ToolEmbedder } from "./embedder";
import { SemanticSearchError } from "./errors";
import {
  ManifestSnapshotEntry,
  type ManifestSnapshotItem,
  MANIFEST_SNAPSHOT_VERSION,
  manifestSnapshotKey,
} from "./manifest-snapshot";
import { cyrb53 } from "./fingerprint";
import type { VectorInput, VectorStore } from "./store";
import type { FtsDocumentInput, FtsLexicalStore } from "./store-fts";

export interface IndexCollections {
  readonly runs: PluginStorageCollectionFacade<typeof indexRuns>;
  readonly jobs: PluginStorageCollectionFacade<typeof indexJobs>;
  readonly chunks: PluginStorageCollectionFacade<typeof indexChunks>;
  readonly fingerprints: PluginStorageCollectionFacade<typeof toolFingerprints>;
  readonly blobs: PluginBlobStore;
  readonly owner: Owner;
}

interface IndexStores extends IndexCollections {
  readonly namespace: string;
  readonly executor: Executor;
  readonly lexicalStore?: FtsLexicalStore;
}

interface IndexDeps extends IndexStores {
  readonly embedder: ToolEmbedder;
  readonly store: VectorStore;
  readonly chunker: Chunker;
}

export declare namespace ToolSearchIndex {
  export interface CreateInput {
    readonly runId: string;
    readonly partitionCount: number;
    readonly maxTools?: number;
  }

  export interface CreateResult {
    readonly runId: string;
    readonly namespace: string;
    readonly total: number;
    readonly partitionCount: number;
  }

  export interface ScanInput {
    readonly runId: string;
    readonly partition: number;
    readonly limit?: number;
    readonly maxTools?: number;
  }

  export interface ScanResult {
    readonly runId: string;
    readonly partition: number;
    readonly processed: number;
    readonly changed: number;
    readonly skipped: number;
    readonly paths: readonly string[];
    readonly hasMore: boolean;
  }

  export interface ChunkRef {
    readonly path: string;
    readonly chunkId: string;
  }

  export interface ChunkInput {
    readonly runId: string;
    readonly paths: readonly string[];
    readonly limit?: number;
    readonly concurrency?: number;
  }

  export interface ChunkResult {
    readonly runId: string;
    readonly processed: number;
    readonly chunks: number;
    readonly paths: readonly string[];
    readonly chunkRefs: readonly ChunkRef[];
    readonly commitPaths: readonly string[];
  }

  export interface EmbedInput {
    readonly runId: string;
    readonly chunkRefs: readonly ChunkRef[];
    readonly maxChunks?: number;
    readonly maxEstimatedInputTokens?: number;
    readonly maxEstimatedResponseBytes?: number;
    readonly maxEstimatedTokensPerText?: number;
  }

  export interface EmbedResult {
    readonly runId: string;
    readonly processed: number;
    readonly chunks: number;
    readonly paths: readonly string[];
    readonly chunkRefs: readonly ChunkRef[];
  }

  export interface CommitInput {
    readonly runId: string;
    readonly paths: readonly string[];
  }

  export interface CommitResult {
    readonly runId: string;
    readonly processed: number;
    readonly committed: number;
    readonly paths: readonly string[];
  }

  export interface CompleteInput {
    readonly runId: string;
  }

  export interface CompleteResult {
    readonly runId: string;
    readonly removed: number;
  }

  export interface FailInput {
    readonly runId: string;
    readonly partition?: number;
    readonly paths?: readonly string[];
    readonly chunkRefs?: readonly ChunkRef[];
    readonly error: string;
  }

  export interface FailResult {
    readonly runId: string;
    readonly jobs: number;
    readonly chunks: number;
    readonly runFailed: boolean;
  }

  export interface ReconcileInput {
    readonly runId: string;
  }

  export interface ReconcileResult {
    readonly runId: string;
    /** The run's original `maxTools` cap (absent = uncapped), so the host can
     *  re-enqueue scan partitions with the same limit on resume. */
    readonly maxTools?: number;
    readonly scanPartitions: readonly number[];
    readonly pendingChunkPaths: readonly string[];
    readonly pendingEmbeddingChunks: readonly ChunkRef[];
    readonly pendingCommitPaths: readonly string[];
  }

  export interface StatusInput {
    readonly runId: string;
  }

  export interface Status {
    readonly runId: string;
    readonly namespace: string;
    readonly status: IndexRun["status"];
    readonly total: number;
    readonly pendingScan: number;
    readonly skipped: number;
    readonly pendingChunk: number;
    readonly pendingEmbedding: number;
    readonly indexed: number;
    readonly failed: number;
    readonly updatedAt?: string;
    readonly lastProgressAt?: string;
  }

  export interface Result {
    readonly namespace: string;
    readonly total: number;
    readonly indexed: number;
    readonly skipped: number;
    readonly removed: number;
  }

  export interface Service {
    readonly create: (input: CreateInput) => Effect.Effect<CreateResult, SemanticSearchError>;
    readonly scan: (input: ScanInput) => Effect.Effect<ScanResult, SemanticSearchError>;
    readonly chunk: (input: ChunkInput) => Effect.Effect<ChunkResult, SemanticSearchError>;
    readonly embed: (input: EmbedInput) => Effect.Effect<EmbedResult, SemanticSearchError>;
    readonly commit: (input: CommitInput) => Effect.Effect<CommitResult, SemanticSearchError>;
    readonly fail: (input: FailInput) => Effect.Effect<FailResult, SemanticSearchError>;
    readonly reconcile: (
      input: ReconcileInput,
    ) => Effect.Effect<ReconcileResult, SemanticSearchError>;
    readonly status: (input: StatusInput) => Effect.Effect<Status, SemanticSearchError>;
    readonly complete: (input: CompleteInput) => Effect.Effect<CompleteResult, SemanticSearchError>;
  }
}

export class ToolSearchIndex extends Context.Service<ToolSearchIndex, ToolSearchIndex.Service>()(
  "@executor-js/semantic-search/ToolSearchIndex",
) {}

const DEFAULT_PAGE_LIMIT = 25;
const DEFAULT_CHUNK_CONCURRENCY = 1;
const DEFAULT_EMBED_MAX_CHUNKS = 128;
const DEFAULT_EMBED_MAX_ESTIMATED_INPUT_TOKENS = 64_000;
const DEFAULT_EMBED_MAX_ESTIMATED_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_EMBED_MAX_ESTIMATED_TOKENS_PER_TEXT = 2_048;
const DEFAULT_EMBED_COMMIT_GROUP_SIZE = 32;
const ESTIMATED_CHARS_PER_TOKEN = 4;
const ESTIMATED_RESPONSE_BYTES_PER_DIMENSION = 16;
const ESTIMATED_RESPONSE_BYTES_PER_VECTOR_OVERHEAD = 512;
const INDEX_STORAGE_CONCURRENCY = 2;
const VECTOR_METADATA_DESCRIPTION_BYTES = 2_048;

const nowIso = (): string => new Date().toISOString();

const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  const encoder = new TextEncoder();
  const scratch = new Uint8Array(4);
  let bytes = 0;
  const chars: string[] = [];
  for (const char of value) {
    const { written } = encoder.encodeInto(char, scratch);
    if (bytes + written > maxBytes) break;
    chars.push(char);
    bytes += written;
  }
  return chars.length === value.length ? value : chars.join("");
};

const partitionForPath = (path: string, partitionCount: number): number =>
  Math.abs(cyrb53(path)) % Math.max(1, Math.floor(partitionCount));

const jobKey = (runId: string, path: string): string => `${runId}:${path}`;

const chunkKey = (runId: string, path: string, chunkId: string): string =>
  `${runId}:${path}:${chunkId}`;

const jobToDescriptor = (job: IndexJob): IndexableToolDescriptor => ({
  address: job.address,
  name: job.name,
  integration: job.integration,
  description: job.description,
});

const queryChunksForJob = (
  deps: IndexCollections,
  job: IndexJob,
): Effect.Effect<
  readonly { readonly key: string; readonly data: IndexChunk }[],
  SemanticSearchError
> =>
  deps.chunks
    .query({
      where: { runId: job.runId, path: job.path },
      orderBy: [{ field: "path", direction: "asc" }],
    })
    .pipe(
      Effect.map((entries) => [...entries].sort((a, b) => a.data.chunkIndex - b.data.chunkIndex)),
      Effect.mapError(
        (cause) => new SemanticSearchError({ message: "Failed to query index chunks.", cause }),
      ),
    );

const queryChunksByPaths = (
  deps: IndexCollections,
  input: {
    readonly runId: string;
    readonly paths: readonly string[];
    readonly status?: IndexChunk["status"];
  },
): Effect.Effect<
  ReadonlyMap<string, readonly { readonly key: string; readonly data: IndexChunk }[]>,
  SemanticSearchError
> => {
  const paths = [...new Set(input.paths)];
  if (paths.length === 0) return Effect.succeed(new Map());
  return deps.chunks
    .query({
      where: {
        runId: input.runId,
        path: { in: paths },
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      orderBy: [{ field: "path", direction: "asc" }],
    })
    .pipe(
      Effect.map((entries) => {
        const grouped = new Map<string, { readonly key: string; readonly data: IndexChunk }[]>();
        for (const entry of entries) {
          const group = grouped.get(entry.data.path);
          if (group) group.push(entry);
          else grouped.set(entry.data.path, [entry]);
        }
        for (const group of grouped.values()) {
          group.sort((a, b) => a.data.chunkIndex - b.data.chunkIndex);
        }
        return grouped;
      }),
      Effect.mapError(
        (cause) => new SemanticSearchError({ message: "Failed to query index chunks.", cause }),
      ),
    );
};

const getChunksByRefs = (
  deps: IndexCollections,
  input: {
    readonly runId: string;
    readonly chunkRefs: readonly ToolSearchIndex.ChunkRef[];
  },
): Effect.Effect<
  readonly { readonly key: string; readonly data: IndexChunk }[],
  SemanticSearchError
> =>
  deps.chunks
    .getManyForOwner({
      owner: deps.owner,
      keys: input.chunkRefs.map((ref) => chunkKey(input.runId, ref.path, ref.chunkId)),
    })
    .pipe(
      Effect.map((entries) =>
        input.chunkRefs.flatMap((ref) => {
          const entry = entries.get(chunkKey(input.runId, ref.path, ref.chunkId));
          return entry === undefined ? [] : [entry];
        }),
      ),
      Effect.mapError(
        (cause) => new SemanticSearchError({ message: "Failed to load index chunks.", cause }),
      ),
    );

interface EmbedBudget {
  readonly maxChunks: number;
  readonly maxEstimatedInputTokens: number;
  readonly maxEstimatedResponseBytes: number;
  readonly maxEstimatedTokensPerText: number;
}

const resolveEmbedBudget = (input: ToolSearchIndex.EmbedInput): EmbedBudget => ({
  maxChunks: Math.max(1, Math.floor(input.maxChunks ?? DEFAULT_EMBED_MAX_CHUNKS)),
  maxEstimatedInputTokens: Math.max(
    1,
    Math.floor(input.maxEstimatedInputTokens ?? DEFAULT_EMBED_MAX_ESTIMATED_INPUT_TOKENS),
  ),
  maxEstimatedResponseBytes: Math.max(
    1,
    Math.floor(input.maxEstimatedResponseBytes ?? DEFAULT_EMBED_MAX_ESTIMATED_RESPONSE_BYTES),
  ),
  maxEstimatedTokensPerText: Math.max(
    1,
    Math.floor(input.maxEstimatedTokensPerText ?? DEFAULT_EMBED_MAX_ESTIMATED_TOKENS_PER_TEXT),
  ),
});

const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN));

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

const payloadKey = (kind: "embedding-text" | "lexical-text", digest: string): string =>
  `semantic-search/index/${kind}/${digest}.txt`;

const indexDocumentKey = (fingerprint: string): string =>
  `semantic-search/index/document/v1/${fingerprint}.json`;

const decodeToolDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolDocumentInput));

const putPayloadText = (
  deps: IndexCollections,
  kind: "embedding-text" | "lexical-text",
  text: string,
): Effect.Effect<string, SemanticSearchError> =>
  Effect.gen(function* () {
    const digest = yield* sha256Hex(text);
    const key = payloadKey(kind, digest);
    yield* deps.blobs.put(key, text, { owner: deps.owner }).pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: `Failed to persist index ${kind} payload "${key}".`,
            cause,
          }),
      ),
    );
    return key;
  });

const getPayloadText = (
  deps: IndexCollections,
  key: string,
): Effect.Effect<string, SemanticSearchError> =>
  deps.blobs.get(key).pipe(
    Effect.mapError(
      (cause) =>
        new SemanticSearchError({ message: `Failed to load index payload "${key}".`, cause }),
    ),
    Effect.flatMap((text) =>
      text === null
        ? Effect.fail(new SemanticSearchError({ message: `Index payload "${key}" is missing.` }))
        : Effect.succeed(text),
    ),
  );

const getCachedToolDocument = (
  deps: IndexCollections,
  fingerprint: string,
): Effect.Effect<ToolDocumentInput | undefined, SemanticSearchError> => {
  const key = indexDocumentKey(fingerprint);
  return deps.blobs.get(key).pipe(
    Effect.mapError(
      (cause) =>
        new SemanticSearchError({ message: `Failed to load index document "${key}".`, cause }),
    ),
    Effect.flatMap((text) => {
      if (text === null) return Effect.sync((): ToolDocumentInput | undefined => undefined);
      return decodeToolDocument(text).pipe(
        Effect.mapError(
          (cause) =>
            new SemanticSearchError({
              message: `Failed to decode index document "${key}".`,
              cause,
            }),
        ),
      );
    }),
  );
};

const putCachedToolDocument = (
  deps: IndexCollections,
  fingerprint: string,
  doc: ToolDocumentInput,
): Effect.Effect<void, SemanticSearchError> =>
  deps.blobs.put(indexDocumentKey(fingerprint), JSON.stringify(doc), { owner: deps.owner }).pipe(
    Effect.mapError(
      (cause) =>
        new SemanticSearchError({
          message: `Failed to persist index document for fingerprint "${fingerprint}".`,
          cause,
        }),
    ),
  );

const deleteCachedToolDocument = (
  deps: Pick<IndexCollections, "blobs" | "owner">,
  fingerprint: string | undefined,
): Effect.Effect<void> =>
  fingerprint === undefined
    ? Effect.void
    : deps.blobs.delete(indexDocumentKey(fingerprint), { owner: deps.owner }).pipe(Effect.ignore);

const estimateEmbeddingResponseBytes = (dimensions: number): number =>
  Math.max(
    1,
    Math.floor(
      dimensions * ESTIMATED_RESPONSE_BYTES_PER_DIMENSION +
        ESTIMATED_RESPONSE_BYTES_PER_VECTOR_OVERHEAD,
    ),
  );

const wouldExceedEmbedBudget = (
  current: {
    readonly chunks: number;
    readonly inputTokens: number;
    readonly responseBytes: number;
  },
  next: { readonly inputTokens: number; readonly responseBytes: number },
  budget: EmbedBudget,
): boolean =>
  current.chunks + 1 > budget.maxChunks ||
  current.inputTokens + next.inputTokens > budget.maxEstimatedInputTokens ||
  current.responseBytes + next.responseBytes > budget.maxEstimatedResponseBytes;

const loadFingerprints = (
  deps: IndexCollections,
  paths: readonly string[],
): Effect.Effect<ReadonlyMap<string, FingerprintRow>, SemanticSearchError> =>
  deps.fingerprints.getManyForOwner({ owner: deps.owner, keys: paths }).pipe(
    Effect.map((entries) => new Map([...entries].map(([path, entry]) => [path, entry.data]))),
    Effect.mapError(
      (cause) =>
        new SemanticSearchError({
          message: "Failed to load index fingerprint rows.",
          cause,
        }),
    ),
  );

const putJob = (deps: IndexCollections, job: IndexJob): Effect.Effect<void, SemanticSearchError> =>
  deps.jobs.put({ owner: deps.owner, key: jobKey(job.runId, job.path), data: job }).pipe(
    Effect.mapError(
      (cause) =>
        new SemanticSearchError({
          message: `Failed to persist index job "${job.path}".`,
          cause,
        }),
    ),
    Effect.asVoid,
  );

const putJobs = (
  deps: IndexCollections,
  jobs: readonly IndexJob[],
): Effect.Effect<void, SemanticSearchError> =>
  deps.jobs
    .putMany({
      owner: deps.owner,
      entries: jobs.map((job) => ({ key: jobKey(job.runId, job.path), data: job })),
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: "Failed to persist index jobs.",
            cause,
          }),
      ),
    );

const getJobsByPaths = (
  deps: IndexCollections,
  input: {
    readonly runId: string;
    readonly paths: readonly string[];
    readonly status: IndexJob["status"];
    readonly limit?: number;
  },
): Effect.Effect<
  readonly { readonly key: string; readonly data: IndexJob }[],
  SemanticSearchError
> =>
  deps.jobs
    .getManyForOwner({
      owner: deps.owner,
      keys: input.paths.map((path) => jobKey(input.runId, path)),
    })
    .pipe(
      Effect.map((entries) =>
        input.paths
          .flatMap((path) => {
            const entry = entries.get(jobKey(input.runId, path));
            return entry !== undefined && entry.data.status === input.status ? [entry] : [];
          })
          .slice(0, input.limit ?? input.paths.length),
      ),
      Effect.mapError(
        (cause) => new SemanticSearchError({ message: "Failed to load index jobs.", cause }),
      ),
    );

const queryJobsByStatus = (
  deps: IndexCollections,
  input: {
    readonly runId: string;
    readonly status: IndexJob["status"];
  },
): Effect.Effect<
  readonly { readonly key: string; readonly data: IndexJob }[],
  SemanticSearchError
> =>
  deps.jobs
    .query({
      where: { runId: input.runId, status: input.status },
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: `Failed to load ${input.status} index jobs.`,
            cause,
          }),
      ),
    );

const loadLatestJobUpdatedAt = (
  collection: PluginStorageCollectionFacade<typeof indexJobs>,
  runId: string,
): Effect.Effect<string | undefined, SemanticSearchError> =>
  collection
    .query({
      where: { runId },
    })
    .pipe(
      Effect.map((entries) =>
        entries
          .map((entry) => entry.data.updatedAt)
          .sort()
          .at(-1),
      ),
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: "Failed to load latest index job progress timestamp.",
            cause,
          }),
      ),
    );

const loadLatestChunkUpdatedAt = (
  collection: PluginStorageCollectionFacade<typeof indexChunks>,
  runId: string,
): Effect.Effect<string | undefined, SemanticSearchError> =>
  collection
    .query({
      where: { runId },
    })
    .pipe(
      Effect.map((entries) =>
        entries
          .map((entry) => entry.data.updatedAt)
          .sort()
          .at(-1),
      ),
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: "Failed to load latest index chunk progress timestamp.",
            cause,
          }),
      ),
    );

const countJobsByStatus = (
  collection: PluginStorageCollectionFacade<typeof indexJobs>,
  runId: string,
): Effect.Effect<Record<IndexJob["status"], number>, SemanticSearchError> =>
  collection.aggregate
    .groupCount({
      field: "status",
      valueType: "text",
      where: { runId },
    })
    .pipe(
      Effect.map((rows) => {
        const counts: Record<IndexJob["status"], number> = {
          pendingScan: 0,
          skipped: 0,
          pendingChunk: 0,
          pendingEmbedding: 0,
          indexed: 0,
          failed: 0,
        };
        for (const row of rows) {
          if (typeof row.value === "string" && row.value in counts) {
            counts[row.value as IndexJob["status"]] = row.count;
          }
        }
        return counts;
      }),
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: "Failed to count index jobs by status.",
            cause,
          }),
      ),
    );

export const fail = (
  input: IndexCollections & ToolSearchIndex.FailInput,
): Effect.Effect<ToolSearchIndex.FailResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const updatedAt = nowIso();
    const paths = new Set(input.paths ?? []);
    const chunkRefs = input.chunkRefs ?? [];
    let jobs = 0;
    let chunks = 0;

    if (paths.size > 0) {
      yield* Effect.forEach(
        [...paths],
        (path) =>
          Effect.gen(function* () {
            const entry = yield* input.jobs
              .getForOwner({ owner: input.owner, key: jobKey(input.runId, path) })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new SemanticSearchError({
                      message: `Failed to load index job "${path}" for failure marking.`,
                      cause,
                    }),
                ),
              );
            if (
              entry !== null &&
              (entry.data.status === "pendingChunk" || entry.data.status === "pendingEmbedding")
            ) {
              yield* putJob(input, {
                ...entry.data,
                status: "failed",
                error: input.error,
                updatedAt,
              });
              jobs++;
            }

            const chunkEntries = yield* input.chunks
              .query({
                where: { runId: input.runId, path, status: "pendingEmbedding" },
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new SemanticSearchError({
                      message: `Failed to load pending chunks for "${path}" failure marking.`,
                      cause,
                    }),
                ),
              );
            yield* Effect.forEach(
              chunkEntries,
              (chunk) =>
                input.chunks
                  .put({
                    owner: input.owner,
                    key: chunk.key,
                    data: { ...chunk.data, status: "failed", error: input.error, updatedAt },
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new SemanticSearchError({
                          message: `Failed to mark chunk "${chunk.data.chunkId}" failed.`,
                          cause,
                        }),
                    ),
                  ),
              { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
            );
            chunks += chunkEntries.length;
          }),
        { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
      );
    }

    if (chunkRefs.length > 0) {
      yield* Effect.forEach(
        chunkRefs,
        (ref) =>
          Effect.gen(function* () {
            const entry = yield* input.chunks
              .getForOwner({
                owner: input.owner,
                key: chunkKey(input.runId, ref.path, ref.chunkId),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new SemanticSearchError({
                      message: `Failed to load chunk "${ref.chunkId}" for failure marking.`,
                      cause,
                    }),
                ),
              );
            if (entry !== null && entry.data.status === "pendingEmbedding") {
              yield* input.chunks
                .put({
                  owner: input.owner,
                  key: entry.key,
                  data: { ...entry.data, status: "failed", error: input.error, updatedAt },
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new SemanticSearchError({
                        message: `Failed to mark chunk "${ref.chunkId}" failed.`,
                        cause,
                      }),
                  ),
                );
              chunks++;
            }
          }),
        { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
      );
    }

    const run = yield* input.runs.getForOwner({ owner: input.owner, key: input.runId }).pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: "Failed to load index run for failure marking.",
            cause,
          }),
      ),
    );
    const runFailed = paths.size === 0 && chunkRefs.length === 0;
    if (runFailed && run !== null) {
      yield* input.runs
        .put({
          owner: input.owner,
          key: input.runId,
          data: {
            ...run.data,
            status: "failed",
            error: input.error,
            updatedAt,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SemanticSearchError({ message: "Failed to mark index run failed.", cause }),
          ),
        );
    }

    return {
      runId: input.runId,
      jobs,
      chunks,
      runFailed,
    };
  });

export const reconcile = (
  input: IndexCollections & ToolSearchIndex.ReconcileInput,
): Effect.Effect<ToolSearchIndex.ReconcileResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const run = yield* input.runs.getForOwner({ owner: input.owner, key: input.runId }).pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: "Failed to load index run for reconciliation.",
            cause,
          }),
      ),
    );
    if (run === null) {
      return yield* new SemanticSearchError({
        message: `Index run "${input.runId}" does not exist.`,
      });
    }

    const [pendingChunkJobs, pendingEmbeddingJobs, pendingEmbeddingChunks] = yield* Effect.all(
      [
        queryJobsByStatus(input, { runId: input.runId, status: "pendingChunk" }),
        queryJobsByStatus(input, { runId: input.runId, status: "pendingEmbedding" }),
        input.chunks
          .query({
            where: { runId: input.runId, status: "pendingEmbedding" },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SemanticSearchError({
                  message: "Failed to load pending embedding chunks.",
                  cause,
                }),
            ),
          ),
      ],
      { concurrency: INDEX_STORAGE_CONCURRENCY },
    );
    const observed = yield* input.jobs.count({ where: { runId: input.runId } }).pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: "Failed to count index jobs for reconciliation.",
            cause,
          }),
      ),
    );
    const scanPartitions =
      observed < run.data.total
        ? Array.from({ length: run.data.partitionCount }, (_, partition) => partition)
        : [];
    const pendingEmbeddingPaths = new Set(pendingEmbeddingChunks.map((entry) => entry.data.path));
    const pendingCommitPaths = pendingEmbeddingJobs
      .map((entry) => entry.data.path)
      .filter((path) => !pendingEmbeddingPaths.has(path));

    return {
      runId: input.runId,
      maxTools: run.data.maxTools,
      scanPartitions,
      pendingChunkPaths: [...new Set(pendingChunkJobs.map((entry) => entry.data.path))],
      pendingEmbeddingChunks: pendingEmbeddingChunks.map((entry) => ({
        path: entry.data.path,
        chunkId: entry.data.chunkId,
      })),
      pendingCommitPaths: [...new Set(pendingCommitPaths)],
    };
  });

const manifestSnapshotStore = (executor: Executor) =>
  KeyValueStore.toSchemaStore(executor.cache, ManifestSnapshotEntry);

/** Partition the run's full manifest list (preserving each entry's ordinal in the
 *  full list) and write one snapshot per partition to the executor cache. Written
 *  once at run creation so the scan phase reads KV instead of re-querying the whole
 *  `tool_schema_manifest` table on every page. Fails loudly: the scan path has no
 *  D1 fallback, so a run must not start without its snapshot. */
const writeManifestSnapshot = (
  executor: Executor,
  runId: string,
  partitionCount: number,
  manifests: readonly ToolSchemaManifest[],
): Effect.Effect<void, SemanticSearchError> =>
  Effect.gen(function* () {
    const store = manifestSnapshotStore(executor);
    const byPartition: ManifestSnapshotItem[][] = Array.from({ length: partitionCount }, () => []);
    manifests.forEach((manifest, ordinal) => {
      byPartition[partitionForPath(manifest.path, partitionCount)]?.push({ ordinal, manifest });
    });
    yield* Effect.forEach(
      byPartition,
      (items, partition) =>
        store.set(manifestSnapshotKey(runId, partition), {
          version: MANIFEST_SNAPSHOT_VERSION,
          items,
        }),
      { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({ message: "Failed to write tool manifest snapshot.", cause }),
      ),
    );
  });

/** Read a partition's manifest snapshot. KV-only by design: a miss fails the scan
 *  so the queue retries (the initial scan fan-out is delayed once to let the write
 *  propagate) — there is deliberately no D1 fallback on this hot path. */
const readManifestSnapshot = (
  executor: Executor,
  runId: string,
  partition: number,
): Effect.Effect<readonly ManifestSnapshotItem[], SemanticSearchError> =>
  manifestSnapshotStore(executor)
    .get(manifestSnapshotKey(runId, partition))
    .pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({ message: "Failed to read tool manifest snapshot.", cause }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new SemanticSearchError({
                message: `Tool manifest snapshot for run "${runId}" partition ${partition} is missing.`,
              }),
            ),
          onSome: (entry) => Effect.succeed(entry.items),
        }),
      ),
    );

/** Best-effort delete of every partition snapshot once a run reaches a terminal
 *  state. (Stalled / terminally-failed runs that never complete leave their
 *  snapshots until overwritten — a small, bounded leak; KV has no native TTL.) */
const deleteManifestSnapshot = (
  executor: Executor,
  runId: string,
  partitionCount: number,
): Effect.Effect<void> =>
  Effect.forEach(
    Array.from({ length: partitionCount }, (_, partition) => partition),
    (partition) => executor.cache.remove(manifestSnapshotKey(runId, partition)),
    { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
  ).pipe(Effect.ignore);

export const create = (
  input: IndexStores & ToolSearchIndex.CreateInput,
): Effect.Effect<ToolSearchIndex.CreateResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const partitionCount = Math.max(1, Math.floor(input.partitionCount));
    const manifests = yield* listToolManifests(input.executor, { maxTools: input.maxTools });
    const createdAt = nowIso();

    yield* writeManifestSnapshot(input.executor, input.runId, partitionCount, manifests);

    yield* input.runs
      .put({
        owner: input.owner,
        key: input.runId,
        data: {
          runId: input.runId,
          namespace: input.namespace,
          status: "running",
          partitionCount,
          total: manifests.length,
          ...(input.maxTools === undefined ? {} : { maxTools: input.maxTools }),
          createdAt,
          updatedAt: createdAt,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) => new SemanticSearchError({ message: "Failed to create index run.", cause }),
        ),
      );

    return {
      runId: input.runId,
      namespace: input.namespace,
      total: manifests.length,
      partitionCount,
    };
  });

export const scan = (
  input: IndexStores & ToolSearchIndex.ScanInput,
): Effect.Effect<ToolSearchIndex.ScanResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const partitionManifests = yield* readManifestSnapshot(
      input.executor,
      input.runId,
      input.partition,
    );

    const existing = yield* input.jobs
      .count({ where: { runId: input.runId, partition: input.partition } })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SemanticSearchError({ message: "Failed to count scanned index jobs.", cause }),
        ),
      );
    const selected = partitionManifests.slice(
      existing,
      existing + (input.limit ?? DEFAULT_PAGE_LIMIT),
    );
    if (selected.length === 0) {
      return {
        runId: input.runId,
        partition: input.partition,
        processed: 0,
        changed: 0,
        skipped: 0,
        paths: [],
        hasMore: false,
      };
    }

    const stored = yield* loadFingerprints(
      input,
      selected.map(({ manifest }) => manifest.path),
    );

    let changed = 0;
    let skipped = 0;
    const changedPaths: string[] = [];
    const jobs: IndexJob[] = [];
    const updatedAt = nowIso();

    for (const { manifest, ordinal } of selected) {
      const storedRow = stored.get(manifest.path);
      const next: IndexJob =
        storedRow !== undefined && storedRow.fingerprint === manifest.indexFingerprint
          ? {
              runId: input.runId,
              namespace: input.namespace,
              partition: input.partition,
              ordinal,
              address: String(manifest.address),
              path: manifest.path,
              name: manifest.name,
              integration: manifest.integration,
              description: manifest.description,
              status: "skipped",
              fingerprint: manifest.indexFingerprint,
              oldFingerprint: storedRow.fingerprint,
              oldChunkIds: storedRow.chunkIds,
              chunkIds: storedRow.chunkIds,
              updatedAt,
              createdAt: updatedAt,
            }
          : {
              runId: input.runId,
              namespace: input.namespace,
              partition: input.partition,
              ordinal,
              address: String(manifest.address),
              path: manifest.path,
              name: manifest.name,
              integration: manifest.integration,
              description: manifest.description,
              status: "pendingChunk",
              fingerprint: manifest.indexFingerprint,
              oldFingerprint: storedRow?.fingerprint,
              oldChunkIds: storedRow?.chunkIds ?? [],
              chunkIds: [],
              updatedAt,
              createdAt: updatedAt,
            };
      if (next.status === "skipped") skipped++;
      else {
        changed++;
        changedPaths.push(next.path);
      }
      jobs.push(next);
    }
    yield* putJobs(input, jobs);

    return {
      runId: input.runId,
      partition: input.partition,
      processed: selected.length,
      changed,
      skipped,
      paths: changedPaths,
      hasMore: existing + selected.length < partitionManifests.length,
    };
  });

export const chunk = (
  input: IndexDeps & ToolSearchIndex.ChunkInput,
): Effect.Effect<ToolSearchIndex.ChunkResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const jobs = yield* getJobsByPaths(input, {
      runId: input.runId,
      status: "pendingChunk",
      paths: input.paths,
      limit: input.limit,
    });
    if (jobs.length === 0) {
      const pendingEmbeddingJobs = yield* getJobsByPaths(input, {
        runId: input.runId,
        status: "pendingEmbedding",
        paths: input.paths,
        limit: input.limit,
      });
      const chunksByPath = yield* queryChunksByPaths(input, {
        runId: input.runId,
        paths: pendingEmbeddingJobs.map((entry) => entry.data.path),
      });
      const existing = pendingEmbeddingJobs.map((entry) => ({
        job: entry.data,
        chunkEntries: chunksByPath.get(entry.data.path) ?? [],
      }));
      const chunkRefs = existing.flatMap(({ chunkEntries }) =>
        chunkEntries
          .filter((entry) => entry.data.status === "pendingEmbedding")
          .map((entry) => ({ path: entry.data.path, chunkId: entry.data.chunkId })),
      );
      const commitPaths = existing
        .filter(({ chunkEntries }) =>
          chunkEntries.every((entry) => entry.data.status === "indexed"),
        )
        .map(({ job }) => job.path);

      return {
        runId: input.runId,
        processed: pendingEmbeddingJobs.length,
        chunks: chunkRefs.length,
        paths: pendingEmbeddingJobs.map((entry) => entry.data.path),
        chunkRefs,
        commitPaths,
      };
    }

    const updatedAt = nowIso();
    const chunkConcurrency = Math.max(
      1,
      Math.floor(input.concurrency ?? DEFAULT_CHUNK_CONCURRENCY),
    );
    const oldChunksByPath = yield* queryChunksByPaths(input, {
      runId: input.runId,
      paths: jobs.map((entry) => entry.data.path),
    });

    const chunkedJobs = yield* Effect.forEach(
      jobs,
      (entry) =>
        Effect.gen(function* () {
          const job = entry.data;
          const doc = yield* Effect.gen(function* () {
            const fingerprint = job.fingerprint;
            if (fingerprint === undefined) {
              return yield* collectDocForTool(input.executor, jobToDescriptor(job));
            }
            const cached = yield* getCachedToolDocument(input, fingerprint);
            if (cached !== undefined) return cached;
            const next = yield* collectDocForTool(input.executor, jobToDescriptor(job));
            yield* putCachedToolDocument(input, fingerprint, next);
            return next;
          });
          const chunks = input.chunker.chunk(input.namespace, doc);
          const lexicalText = doc.lexicalText ?? buildLexicalText(doc);
          const lexicalTextKey = yield* putPayloadText(input, "lexical-text", lexicalText);
          const chunkEntries = yield* Effect.forEach(
            chunks,
            (chunk) => makeChunkEntry(input, job, chunk, updatedAt),
            { concurrency: INDEX_STORAGE_CONCURRENCY },
          );
          const updatedJob: IndexJob = {
            ...job,
            status: "pendingEmbedding",
            chunkIds: chunks.map((chunk) => chunk.id),
            lexicalTextKey,
            updatedAt,
          };
          return {
            path: job.path,
            chunks: chunks.length,
            oldChunkKeys: (oldChunksByPath.get(job.path) ?? []).map((chunk) => chunk.key),
            chunkEntries,
            chunkRefs: chunks.map((chunk) => ({ path: job.path, chunkId: chunk.id })),
            updatedJob,
            commitPath: chunks.length === 0 ? job.path : undefined,
          };
        }),
      { concurrency: chunkConcurrency },
    );
    const oldChunkKeys = chunkedJobs.flatMap((job) => job.oldChunkKeys);
    if (oldChunkKeys.length > 0) {
      yield* input.chunks.removeMany({ owner: input.owner, keys: oldChunkKeys }).pipe(
        Effect.mapError(
          (cause) =>
            new SemanticSearchError({
              message: "Failed to remove stale index chunks.",
              cause,
            }),
        ),
      );
    }
    const chunkEntries = chunkedJobs.flatMap((job) => job.chunkEntries);
    if (chunkEntries.length > 0) {
      yield* input.chunks.putMany({ owner: input.owner, entries: chunkEntries }).pipe(
        Effect.mapError(
          (cause) =>
            new SemanticSearchError({
              message: "Failed to persist index chunks.",
              cause,
            }),
        ),
      );
    }
    yield* putJobs(
      input,
      chunkedJobs.map((job) => job.updatedJob),
    );
    const chunkCount = chunkedJobs.reduce((sum, job) => sum + job.chunks, 0);

    return {
      runId: input.runId,
      processed: jobs.length,
      chunks: chunkCount,
      paths: chunkedJobs.map((job) => job.path),
      chunkRefs: chunkedJobs.flatMap((job) => job.chunkRefs),
      commitPaths: chunkedJobs.flatMap((job) =>
        job.commitPath === undefined ? [] : [job.commitPath],
      ),
    };
  });

const makeChunkEntry = (
  deps: IndexCollections,
  job: IndexJob,
  chunk: ToolChunk,
  timestamp: string,
): Effect.Effect<{ readonly key: string; readonly data: IndexChunk }, SemanticSearchError> =>
  Effect.gen(function* () {
    const embeddingTextKey = yield* putPayloadText(deps, "embedding-text", chunk.embeddingText);
    const data: IndexChunk = {
      runId: job.runId,
      namespace: job.namespace,
      partition: job.partition,
      path: job.path,
      chunkId: chunk.id,
      facet: chunk.facet,
      chunkIndex: chunk.chunkIndex,
      embeddingTextKey,
      embeddingTextBytes: utf8Bytes(chunk.embeddingText),
      embeddingTextTokens: estimateTokens(chunk.embeddingText),
      name: chunk.name,
      integration: chunk.integration,
      description: job.description,
      status: "pendingEmbedding",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return {
      key: chunkKey(job.runId, job.path, chunk.id),
      data,
    };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SemanticSearchError({ message: `Failed to prepare chunk "${chunk.id}".`, cause }),
    ),
  );

export const embed = (
  input: IndexDeps & ToolSearchIndex.EmbedInput,
): Effect.Effect<ToolSearchIndex.EmbedResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const budget = resolveEmbedBudget(input);
    const chunkEntries = yield* getChunksByRefs(input, {
      runId: input.runId,
      chunkRefs: input.chunkRefs,
    });
    const alreadyIndexed = chunkEntries.filter((entry) => entry.data.status === "indexed");
    const selectedChunks: { readonly key: string; readonly data: IndexChunk }[] = [];
    const vectorResponseBytes = estimateEmbeddingResponseBytes(input.embedder.dimensions);
    let selectedInputTokens = 0;
    let selectedResponseBytes = 0;

    for (const entry of chunkEntries) {
      if (entry.data.status !== "pendingEmbedding") continue;
      const inputTokens = entry.data.embeddingTextTokens;
      if (inputTokens > budget.maxEstimatedTokensPerText) {
        return yield* new SemanticSearchError({
          message: `Index chunk "${entry.data.chunkId}" is estimated at ${inputTokens} tokens, above the per-text embedding budget of ${budget.maxEstimatedTokensPerText}. Lower the chunker facet budget or raise maxEstimatedTokensPerText.`,
        });
      }

      const next = { inputTokens, responseBytes: vectorResponseBytes };
      const current = {
        chunks: selectedChunks.length,
        inputTokens: selectedInputTokens,
        responseBytes: selectedResponseBytes,
      };
      if (selectedChunks.length > 0 && wouldExceedEmbedBudget(current, next, budget)) {
        break;
      }

      selectedChunks.push(entry);
      selectedInputTokens += inputTokens;
      selectedResponseBytes += vectorResponseBytes;
    }

    if (selectedChunks.length === 0) {
      return {
        runId: input.runId,
        processed: 0,
        chunks: 0,
        paths: [...new Set(alreadyIndexed.map((entry) => entry.data.path))],
        chunkRefs: alreadyIndexed.map((entry) => ({
          path: entry.data.path,
          chunkId: entry.data.chunkId,
        })),
      };
    }

    const updatedAt = nowIso();
    const affectedPaths = new Set(alreadyIndexed.map((entry) => entry.data.path));
    const affectedChunks: ToolSearchIndex.ChunkRef[] = alreadyIndexed.map((entry) => ({
      path: entry.data.path,
      chunkId: entry.data.chunkId,
    }));
    let indexedChunks = 0;

    for (let start = 0; start < selectedChunks.length; start += DEFAULT_EMBED_COMMIT_GROUP_SIZE) {
      const group = selectedChunks.slice(start, start + DEFAULT_EMBED_COMMIT_GROUP_SIZE);
      const texts = yield* Effect.forEach(
        group,
        (entry) => getPayloadText(input, entry.data.embeddingTextKey),
        { concurrency: INDEX_STORAGE_CONCURRENCY },
      );
      const vectors = yield* input.embedder.embedDocuments(texts);
      const records: VectorInput[] = [];

      for (let i = 0; i < group.length; i++) {
        const chunk = group[i]?.data;
        const vec = vectors[i];
        if (chunk === undefined || vec === undefined) {
          return yield* new SemanticSearchError({
            message: `ToolSearchIndex.embed: embedding vector missing at group offset ${i}; expected ${group.length} vectors and received ${vectors.length}.`,
          });
        }
        records.push({
          id: chunk.chunkId,
          values: vec,
          namespace: input.namespace,
          metadata: {
            path: chunk.path,
            name: chunk.name,
            description: truncateUtf8(chunk.description, VECTOR_METADATA_DESCRIPTION_BYTES),
            integration: chunk.integration,
            facet: chunk.facet,
            chunkIndex: chunk.chunkIndex,
          },
        });
      }

      yield* input.store.upsert(records);
      yield* input.chunks
        .putMany({
          owner: input.owner,
          entries: group.map((entry) => ({
            key: entry.key,
            data: { ...entry.data, status: "indexed", updatedAt },
          })),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SemanticSearchError({
                message: "Failed to mark chunks indexed.",
                cause,
              }),
          ),
        );

      indexedChunks += records.length;
      for (const entry of group) {
        affectedPaths.add(entry.data.path);
        affectedChunks.push({ path: entry.data.path, chunkId: entry.data.chunkId });
      }
    }

    return {
      runId: input.runId,
      processed: indexedChunks,
      chunks: indexedChunks,
      paths: [...affectedPaths],
      chunkRefs: affectedChunks,
    };
  });

export const commit = (
  input: IndexDeps & ToolSearchIndex.CommitInput,
): Effect.Effect<ToolSearchIndex.CommitResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const paths = [...new Set(input.paths)];
    const entries = yield* getJobsByPaths(input, {
      runId: input.runId,
      status: "pendingEmbedding",
      paths,
    });
    if (entries.length === 0) {
      return { runId: input.runId, processed: 0, committed: 0, paths: [] };
    }

    const chunksByPath = yield* queryChunksByPaths(input, {
      runId: input.runId,
      paths: entries.map((entry) => entry.data.path),
    });
    const committed = yield* finalizeCompletedEmbedJobs(input, entries, chunksByPath, nowIso());
    return {
      runId: input.runId,
      processed: entries.length,
      committed,
      paths: entries.map((entry) => entry.data.path),
    };
  });

const finalizeCompletedEmbedJobs = (
  input: IndexDeps,
  jobs: readonly { readonly key: string; readonly data: IndexJob }[],
  preloadedChunks:
    | ReadonlyMap<string, readonly { readonly key: string; readonly data: IndexChunk }[]>
    | undefined,
  updatedAt: string,
): Effect.Effect<number, SemanticSearchError> =>
  Effect.gen(function* () {
    const fingerprintRows: {
      readonly key: string;
      readonly data: FingerprintRow;
    }[] = [];
    const indexedJobs: IndexJob[] = [];
    const oldChunkIds: string[] = [];
    const oldDocumentFingerprints: string[] = [];
    const lexicalDocs: FtsDocumentInput[] = [];

    for (const { data: job } of jobs) {
      const chunkEntries = preloadedChunks?.get(job.path) ?? (yield* queryChunksForJob(input, job));
      if (chunkEntries.some((entry) => entry.data.status !== "indexed")) {
        continue;
      }

      const fingerprint = job.fingerprint;
      if (fingerprint === undefined) {
        return yield* new SemanticSearchError({
          message: `Index job "${job.path}" reached embedding without a fingerprint.`,
        });
      }

      fingerprintRows.push({
        key: job.path,
        data: {
          path: job.path,
          integration: job.integration,
          fingerprint,
          chunkIds: job.chunkIds,
        },
      });

      if (job.oldChunkIds.length > 0) {
        oldChunkIds.push(...job.oldChunkIds);
      }
      if (job.oldFingerprint !== undefined && job.oldFingerprint !== fingerprint) {
        oldDocumentFingerprints.push(job.oldFingerprint);
      }

      if (input.lexicalStore) {
        const lexicalText =
          job.lexicalTextKey === undefined
            ? `${job.integration} · ${job.path} · ${job.name}`
            : yield* getPayloadText(input, job.lexicalTextKey);
        const lexicalDoc: FtsDocumentInput = {
          id: `${input.namespace}:${job.path}`,
          namespace: input.namespace,
          path: job.path,
          name: job.name,
          description: job.description,
          integration: job.integration,
          lexicalText,
        };
        lexicalDocs.push(lexicalDoc);
      }

      indexedJobs.push({ ...job, status: "indexed", updatedAt });
    }

    if (fingerprintRows.length > 0) {
      yield* input.fingerprints.putMany({ owner: input.owner, entries: fingerprintRows }).pipe(
        Effect.mapError(
          (cause) =>
            new SemanticSearchError({
              message: "Failed to persist fingerprint rows.",
              cause,
            }),
        ),
      );
    }
    if (oldChunkIds.length > 0) {
      yield* input.store.deleteByIds([...new Set(oldChunkIds)]);
    }
    yield* Effect.forEach(
      [...new Set(oldDocumentFingerprints)],
      (fingerprint) => deleteCachedToolDocument(input, fingerprint),
      { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
    );
    if (input.lexicalStore && lexicalDocs.length > 0) {
      yield* input.lexicalStore.upsert(lexicalDocs);
    }
    if (indexedJobs.length > 0) {
      yield* putJobs(input, indexedJobs);
    }
    return indexedJobs.length;
  });

export const status = (
  input: IndexCollections & { readonly namespace: string; readonly runId: string },
): Effect.Effect<ToolSearchIndex.Status, SemanticSearchError> =>
  Effect.gen(function* () {
    const run = yield* input.runs
      .getForOwner({ owner: input.owner, key: input.runId })
      .pipe(
        Effect.mapError(
          (cause) => new SemanticSearchError({ message: "Failed to load index run.", cause }),
        ),
      );
    const statusCounts = yield* countJobsByStatus(input.jobs, input.runId);
    const counts = yield* Effect.all(
      {
        latestJobUpdatedAt: loadLatestJobUpdatedAt(input.jobs, input.runId),
        latestChunkUpdatedAt: loadLatestChunkUpdatedAt(input.chunks, input.runId),
      },
      { concurrency: INDEX_STORAGE_CONCURRENCY },
    );
    const observed =
      statusCounts.pendingScan +
      statusCounts.skipped +
      statusCounts.pendingChunk +
      statusCounts.pendingEmbedding +
      statusCounts.indexed +
      statusCounts.failed;
    const total = run?.data.total ?? observed;
    const pendingScan = Math.max(0, total - observed + statusCounts.pendingScan);
    const lastProgressAt = [
      run?.data.updatedAt,
      counts.latestJobUpdatedAt,
      counts.latestChunkUpdatedAt,
    ]
      .filter(Predicate.isNotUndefined)
      .sort()
      .at(-1);
    return {
      runId: input.runId,
      namespace: run?.data.namespace ?? input.namespace,
      status: run?.data.status ?? "running",
      total,
      pendingScan,
      skipped: statusCounts.skipped,
      pendingChunk: statusCounts.pendingChunk,
      pendingEmbedding: statusCounts.pendingEmbedding,
      indexed: statusCounts.indexed,
      failed: statusCounts.failed,
      updatedAt: run?.data.updatedAt,
      lastProgressAt,
    };
  });

export const sweepRemoved = (input: {
  readonly namespace: string;
  readonly executor: Executor;
  readonly store: VectorStore;
  readonly fingerprints: PluginStorageCollectionFacade<typeof toolFingerprints>;
  readonly blobs: PluginBlobStore;
  readonly owner: Owner;
  readonly lexicalStore?: FtsLexicalStore;
}): Effect.Effect<{ readonly namespace: string; readonly removed: number }, SemanticSearchError> =>
  Effect.gen(function* () {
    const live = yield* listToolDescriptors(input.executor);
    if (live.length === 0) return { namespace: input.namespace, removed: 0 };

    const livePaths = new Set(live.map((tool) => addressToPath(String(tool.address))));
    const stored = yield* input.fingerprints.list().pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: "Failed to load fingerprint rows for removed-tool sweep.",
            cause,
          }),
      ),
    );
    const removed = stored.filter((entry) => !livePaths.has(entry.key));

    yield* Effect.forEach(
      removed,
      (entry) =>
        Effect.gen(function* () {
          if (entry.data.chunkIds.length > 0) {
            yield* input.store.deleteByIds(entry.data.chunkIds);
          }
          if (input.lexicalStore) {
            yield* input.lexicalStore.deleteByIds([`${input.namespace}:${entry.key}`]);
          }
          yield* deleteCachedToolDocument(input, entry.data.fingerprint);
          yield* input.fingerprints.remove({ owner: input.owner, key: entry.key }).pipe(
            Effect.mapError(
              (cause) =>
                new SemanticSearchError({
                  message: `Failed to delete fingerprint row for removed tool "${entry.key}".`,
                  cause,
                }),
            ),
          );
        }),
      { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
    );

    return { namespace: input.namespace, removed: removed.length };
  });

export const complete = (
  input: IndexDeps & ToolSearchIndex.CompleteInput,
): Effect.Effect<ToolSearchIndex.CompleteResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const result = yield* sweepRemoved({
      namespace: input.namespace,
      executor: input.executor,
      store: input.store,
      fingerprints: input.fingerprints,
      blobs: input.blobs,
      owner: input.owner,
      lexicalStore: input.lexicalStore,
    });
    const existing = yield* input.runs.getForOwner({ owner: input.owner, key: input.runId }).pipe(
      Effect.mapError(
        (cause) =>
          new SemanticSearchError({
            message: "Failed to load index run for completion.",
            cause,
          }),
      ),
    );
    const updatedAt = nowIso();
    if (existing !== null) {
      yield* input.runs
        .put({
          owner: input.owner,
          key: input.runId,
          data: { ...existing.data, status: "completed", updatedAt },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SemanticSearchError({ message: "Failed to mark index run completed.", cause }),
          ),
        );
      yield* deleteManifestSnapshot(input.executor, input.runId, existing.data.partitionCount);
    }
    return { runId: input.runId, removed: result.removed };
  });

export const run = (
  input: IndexDeps & {
    readonly runId: string;
    readonly partitionCount: number;
    readonly pageLimit?: number;
    readonly maxTools?: number;
  },
): Effect.Effect<ToolSearchIndex.Result, SemanticSearchError> =>
  Effect.gen(function* () {
    const started = yield* create(input);
    for (let partition = 0; partition < started.partitionCount; partition++) {
      for (;;) {
        const page = yield* scan({
          ...input,
          partition,
          limit: input.pageLimit,
        });
        if (page.processed === 0) break;
        if (page.paths.length > 0) {
          const chunked = yield* chunk({
            ...input,
            paths: page.paths,
            limit: input.pageLimit,
          });
          let pendingChunks = [...chunked.chunkRefs];
          if (chunked.commitPaths.length > 0) {
            yield* commit({ ...input, runId: input.runId, paths: chunked.commitPaths });
          }
          while (pendingChunks.length > 0) {
            const embedded = yield* embed({
              ...input,
              chunkRefs: pendingChunks,
              maxChunks: input.pageLimit,
            });
            if (embedded.processed === 0 || embedded.chunks === 0) break;
            const embeddedKeys = new Set(
              embedded.chunkRefs.map((ref) => `${ref.path}:${ref.chunkId}`),
            );
            pendingChunks = pendingChunks.filter(
              (ref) => !embeddedKeys.has(`${ref.path}:${ref.chunkId}`),
            );
            if (embedded.paths.length > 0) {
              yield* commit({ ...input, runId: input.runId, paths: embedded.paths });
            }
          }
        }
        if (!page.hasMore) break;
      }
    }
    const completed = yield* complete(input);
    const current = yield* status(input);
    return {
      namespace: input.namespace,
      total: current.total,
      indexed: current.indexed,
      skipped: current.skipped,
      removed: completed.removed,
    };
  });

export const make = (input: IndexDeps): ToolSearchIndex.Service => ({
  create: (options) => create({ ...input, ...options }),
  scan: (options) => scan({ ...input, ...options }),
  chunk: (options) => chunk({ ...input, ...options }),
  embed: (options) => embed({ ...input, ...options }),
  commit: (options) => commit({ ...input, ...options }),
  fail: (options) => fail({ ...input, ...options }),
  reconcile: (options) => reconcile({ ...input, ...options }),
  status: (options) => status({ ...input, ...options }),
  complete: (options) => complete({ ...input, ...options }),
});
