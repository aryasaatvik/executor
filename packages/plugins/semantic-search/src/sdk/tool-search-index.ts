import type {
  Executor,
  Owner,
  PluginBlobStore,
  PluginStorageCollectionFacade,
} from "@executor-js/sdk/core";
import { sha256Hex } from "@executor-js/sdk/core";
import { Context, Effect, Predicate } from "effect";

import type { Chunker, ToolChunk } from "./chunker";
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
  collectFingerprintInputs,
  type IndexableToolDescriptor,
  listToolDescriptors,
} from "./documents";
import type { ToolEmbedder } from "./embedder";
import { SemanticSearchError } from "./errors";
import { cyrb53, fingerprintTool } from "./fingerprint";
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
    readonly path: string;
  }

  export interface CommitResult {
    readonly runId: string;
    readonly path: string;
    readonly committed: boolean;
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

const nowIso = (): string => new Date().toISOString();

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
  Effect.forEach(
    input.chunkRefs,
    (ref) =>
      deps.chunks
        .getForOwner({ owner: deps.owner, key: chunkKey(input.runId, ref.path, ref.chunkId) })
        .pipe(Effect.map((entry) => (entry?.data.status === "pendingEmbedding" ? entry : null))),
    { concurrency: INDEX_STORAGE_CONCURRENCY },
  ).pipe(
    Effect.map((entries) => entries.flatMap((entry) => (entry === null ? [] : [entry]))),
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
  Effect.forEach(
    paths,
    (path) =>
      deps.fingerprints
        .getForOwner({ owner: deps.owner, key: path })
        .pipe(Effect.map((entry) => [path, entry?.data ?? null] as const)),
    { concurrency: INDEX_STORAGE_CONCURRENCY },
  ).pipe(
    Effect.map(
      (pairs) =>
        new Map(pairs.flatMap(([path, data]) => (data === null ? [] : [[path, data] as const]))),
    ),
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

const removeChunksForJob = (
  deps: IndexCollections,
  job: IndexJob,
): Effect.Effect<void, SemanticSearchError> =>
  queryChunksForJob(deps, job).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry) =>
          deps.chunks.remove({ owner: deps.owner, key: entry.key }).pipe(
            Effect.mapError(
              (cause) =>
                new SemanticSearchError({
                  message: `Failed to remove index chunk "${entry.key}".`,
                  cause,
                }),
            ),
          ),
        { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
      ),
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
  Effect.forEach(
    input.paths,
    (path) =>
      deps.jobs
        .getForOwner({ owner: deps.owner, key: jobKey(input.runId, path) })
        .pipe(Effect.map((entry) => (entry?.data.status === input.status ? entry : null))),
    { concurrency: INDEX_STORAGE_CONCURRENCY },
  ).pipe(
    Effect.map((entries) =>
      entries
        .flatMap((entry) => (entry === null ? [] : [entry]))
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
      scanPartitions,
      pendingChunkPaths: [...new Set(pendingChunkJobs.map((entry) => entry.data.path))],
      pendingEmbeddingChunks: pendingEmbeddingChunks.map((entry) => ({
        path: entry.data.path,
        chunkId: entry.data.chunkId,
      })),
      pendingCommitPaths: [...new Set(pendingCommitPaths)],
    };
  });

export const create = (
  input: IndexStores & ToolSearchIndex.CreateInput,
): Effect.Effect<ToolSearchIndex.CreateResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const partitionCount = Math.max(1, Math.floor(input.partitionCount));
    const descriptors = yield* listToolDescriptors(input.executor, { maxTools: input.maxTools });
    const createdAt = nowIso();

    yield* input.runs
      .put({
        owner: input.owner,
        key: input.runId,
        data: {
          runId: input.runId,
          namespace: input.namespace,
          status: "running",
          partitionCount,
          total: descriptors.length,
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
      total: descriptors.length,
      partitionCount,
    };
  });

export const scan = (
  input: IndexStores & ToolSearchIndex.ScanInput,
): Effect.Effect<ToolSearchIndex.ScanResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const run = yield* input.runs
      .getForOwner({ owner: input.owner, key: input.runId })
      .pipe(
        Effect.mapError(
          (cause) => new SemanticSearchError({ message: "Failed to load index run.", cause }),
        ),
      );
    if (run === null) {
      return yield* new SemanticSearchError({
        message: `Index run "${input.runId}" does not exist.`,
      });
    }

    const descriptors = yield* listToolDescriptors(input.executor, { maxTools: input.maxTools });
    const partitionDescriptors = descriptors
      .map((tool, ordinal) => ({ tool, ordinal, path: addressToPath(String(tool.address)) }))
      .filter(({ path }) => partitionForPath(path, run.data.partitionCount) === input.partition);
    const existing = yield* input.jobs
      .count({ where: { runId: input.runId, partition: input.partition } })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SemanticSearchError({ message: "Failed to count scanned index jobs.", cause }),
        ),
      );
    const selected = partitionDescriptors.slice(
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

    const fingerprintInputs = yield* collectFingerprintInputs(
      input.executor,
      selected.map(({ tool }) => tool),
    );
    const stored = yield* loadFingerprints(
      input,
      fingerprintInputs.map(({ input: fp }) => fp.path),
    );

    let changed = 0;
    let skipped = 0;
    const changedPaths: string[] = [];
    const selectedByPath = new Map(selected.map((entry) => [entry.path, entry]));
    const updatedAt = nowIso();

    yield* Effect.forEach(
      fingerprintInputs,
      ({ input: fp }) => {
        const selectedEntry = selectedByPath.get(fp.path);
        if (selectedEntry === undefined) return Effect.void;
        const fingerprint = fingerprintTool(fp);
        const storedRow = stored.get(fp.path);
        const { tool, ordinal, path } = selectedEntry;
        const next: IndexJob =
          storedRow !== undefined && storedRow.fingerprint === fingerprint
            ? {
                runId: input.runId,
                namespace: input.namespace,
                partition: input.partition,
                ordinal,
                address: String(tool.address),
                path,
                name: String(tool.name),
                integration: String(tool.integration),
                description: String(tool.description ?? ""),
                status: "skipped",
                fingerprint,
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
                address: String(tool.address),
                path,
                name: String(tool.name),
                integration: String(tool.integration),
                description: String(tool.description ?? ""),
                status: "pendingChunk",
                fingerprint,
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
        return putJob(input, next);
      },
      { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
    );

    return {
      runId: input.runId,
      partition: input.partition,
      processed: selected.length,
      changed,
      skipped,
      paths: changedPaths,
      hasMore: existing + selected.length < partitionDescriptors.length,
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
      return {
        runId: input.runId,
        processed: 0,
        chunks: 0,
        paths: [],
        chunkRefs: [],
        commitPaths: [],
      };
    }

    const updatedAt = nowIso();
    const chunkConcurrency = Math.max(
      1,
      Math.floor(input.concurrency ?? DEFAULT_CHUNK_CONCURRENCY),
    );
    const paths: string[] = [];
    const chunkRefs: ToolSearchIndex.ChunkRef[] = [];
    const commitPaths: string[] = [];

    const chunkCounts = yield* Effect.forEach(
      jobs,
      (entry) =>
        Effect.gen(function* () {
          const job = entry.data;
          const doc = yield* collectDocForTool(input.executor, jobToDescriptor(job));
          const chunks = input.chunker.chunk(input.namespace, doc);
          const lexicalText = doc.lexicalText ?? buildLexicalText(doc);
          const lexicalTextKey = yield* putPayloadText(input, "lexical-text", lexicalText);
          yield* removeChunksForJob(input, job);
          yield* Effect.forEach(chunks, (chunk) => putChunk(input, job, chunk, updatedAt), {
            concurrency: INDEX_STORAGE_CONCURRENCY,
            discard: true,
          });
          for (const chunk of chunks) {
            chunkRefs.push({ path: job.path, chunkId: chunk.id });
          }
          yield* putJob(input, {
            ...job,
            status: "pendingEmbedding",
            chunkIds: chunks.map((chunk) => chunk.id),
            lexicalTextKey,
            updatedAt,
          });
          paths.push(job.path);
          if (chunks.length === 0) {
            commitPaths.push(job.path);
          }
          return chunks.length;
        }),
      { concurrency: chunkConcurrency },
    );
    const chunkCount = chunkCounts.reduce((sum, count) => sum + count, 0);

    return {
      runId: input.runId,
      processed: jobs.length,
      chunks: chunkCount,
      paths,
      chunkRefs,
      commitPaths,
    };
  });

const putChunk = (
  deps: IndexCollections,
  job: IndexJob,
  chunk: ToolChunk,
  timestamp: string,
): Effect.Effect<void, SemanticSearchError> =>
  Effect.gen(function* () {
    const embeddingTextKey = yield* putPayloadText(deps, "embedding-text", chunk.embeddingText);
    yield* deps.chunks.put({
      owner: deps.owner,
      key: chunkKey(job.runId, job.path, chunk.id),
      data: {
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
      },
    });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SemanticSearchError({ message: `Failed to persist chunk "${chunk.id}".`, cause }),
    ),
    Effect.asVoid,
  );

export const embed = (
  input: IndexDeps & ToolSearchIndex.EmbedInput,
): Effect.Effect<ToolSearchIndex.EmbedResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const budget = resolveEmbedBudget(input);
    const pendingChunks = yield* getChunksByRefs(input, {
      runId: input.runId,
      chunkRefs: input.chunkRefs,
    });
    const selectedChunks: { readonly key: string; readonly data: IndexChunk }[] = [];
    const vectorResponseBytes = estimateEmbeddingResponseBytes(input.embedder.dimensions);
    let selectedInputTokens = 0;
    let selectedResponseBytes = 0;

    for (const entry of pendingChunks) {
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
      return { runId: input.runId, processed: 0, chunks: 0, paths: [], chunkRefs: [] };
    }

    const updatedAt = nowIso();
    const affectedPaths = new Set<string>();
    const affectedChunks: ToolSearchIndex.ChunkRef[] = [];
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
            description: chunk.description,
            integration: chunk.integration,
            facet: chunk.facet,
            chunkIndex: chunk.chunkIndex,
          },
        });
      }

      yield* input.store.upsert(records);
      yield* Effect.forEach(
        group,
        (entry) =>
          input.chunks
            .put({
              owner: input.owner,
              key: entry.key,
              data: { ...entry.data, status: "indexed", updatedAt },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SemanticSearchError({
                    message: `Failed to mark chunk "${entry.data.chunkId}" indexed.`,
                    cause,
                  }),
              ),
            ),
        { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
      );

      indexedChunks += records.length;
      for (const entry of group) {
        affectedPaths.add(entry.data.path);
        affectedChunks.push({ path: entry.data.path, chunkId: entry.data.chunkId });
      }
    }

    return {
      runId: input.runId,
      processed: affectedChunks.length,
      chunks: indexedChunks,
      paths: [...affectedPaths],
      chunkRefs: affectedChunks,
    };
  });

export const commit = (
  input: IndexDeps & ToolSearchIndex.CommitInput,
): Effect.Effect<ToolSearchIndex.CommitResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const entry = yield* input.jobs
      .getForOwner({ owner: input.owner, key: jobKey(input.runId, input.path) })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SemanticSearchError({
              message: `Failed to load index job "${input.path}" for commit.`,
              cause,
            }),
        ),
      );
    if (entry === null || entry.data.status !== "pendingEmbedding") {
      return { runId: input.runId, path: input.path, committed: false };
    }

    const committed = yield* finalizeCompletedEmbedJobs(input, [entry], undefined, nowIso());
    return { runId: input.runId, path: input.path, committed: committed > 0 };
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
    let finalized = 0;
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

      yield* input.fingerprints
        .put({
          owner: input.owner,
          key: job.path,
          data: {
            path: job.path,
            integration: job.integration,
            fingerprint,
            chunkIds: job.chunkIds,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SemanticSearchError({
                message: `Failed to persist fingerprint row for "${job.path}".`,
                cause,
              }),
          ),
        );

      if (job.oldChunkIds.length > 0) {
        yield* input.store.deleteByIds(job.oldChunkIds);
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
        yield* input.lexicalStore.upsert([lexicalDoc]);
      }

      yield* putJob(input, { ...job, status: "indexed", updatedAt });
      finalized++;
    }
    return finalized;
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
    const count = (status: IndexJob["status"]) =>
      input.jobs
        .count({ where: { runId: input.runId, status } })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SemanticSearchError({ message: `Failed to count ${status} jobs.`, cause }),
          ),
        );
    const counts = yield* Effect.all(
      {
        storedPendingScan: count("pendingScan"),
        skipped: count("skipped"),
        pendingChunk: count("pendingChunk"),
        pendingEmbedding: count("pendingEmbedding"),
        indexed: count("indexed"),
        failed: count("failed"),
        latestJobUpdatedAt: loadLatestJobUpdatedAt(input.jobs, input.runId),
        latestChunkUpdatedAt: loadLatestChunkUpdatedAt(input.chunks, input.runId),
      },
      { concurrency: INDEX_STORAGE_CONCURRENCY },
    );
    const observed =
      counts.storedPendingScan +
      counts.skipped +
      counts.pendingChunk +
      counts.pendingEmbedding +
      counts.indexed +
      counts.failed;
    const total = run?.data.total ?? observed;
    const pendingScan = Math.max(0, total - observed + counts.storedPendingScan);
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
      skipped: counts.skipped,
      pendingChunk: counts.pendingChunk,
      pendingEmbedding: counts.pendingEmbedding,
      indexed: counts.indexed,
      failed: counts.failed,
      updatedAt: run?.data.updatedAt,
      lastProgressAt,
    };
  });

export const sweepRemoved = (input: {
  readonly namespace: string;
  readonly executor: Executor;
  readonly store: VectorStore;
  readonly fingerprints: PluginStorageCollectionFacade<typeof toolFingerprints>;
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
          for (const path of chunked.commitPaths) {
            yield* commit({ ...input, runId: input.runId, path });
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
            for (const path of embedded.paths) {
              yield* commit({ ...input, runId: input.runId, path });
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
