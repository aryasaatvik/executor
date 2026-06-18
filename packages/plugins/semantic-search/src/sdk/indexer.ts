import type {
  Executor,
  Owner,
  PluginBlobStore,
  PluginStorageCollectionFacade,
} from "@executor-js/sdk/core";
import { sha256Hex } from "@executor-js/sdk/core";
import { Effect } from "effect";

import type { Chunker, ToolChunk } from "./chunker";
import {
  type FingerprintRow,
  type IndexChunk,
  type IndexJob,
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

export interface StartIndexRunInput {
  readonly runId: string;
  readonly partitionCount: number;
}

export interface StartIndexRunResult {
  readonly runId: string;
  readonly namespace: string;
  readonly total: number;
  readonly partitionCount: number;
}

export interface IndexPageInput {
  readonly runId: string;
  readonly partition: number;
  readonly limit?: number;
  readonly materializeConcurrency?: number;
  readonly maxChunks?: number;
  readonly maxEstimatedInputTokens?: number;
  readonly maxEstimatedResponseBytes?: number;
  readonly maxEstimatedTokensPerText?: number;
}

export interface IndexDiffPageResult {
  readonly runId: string;
  readonly partition: number;
  readonly processed: number;
  readonly changed: number;
  readonly unchanged: number;
}

export interface IndexMaterializePageResult {
  readonly runId: string;
  readonly partition: number;
  readonly processed: number;
  readonly chunks: number;
}

export interface IndexEmbedPageResult {
  readonly runId: string;
  readonly partition: number;
  readonly processed: number;
  readonly chunks: number;
}

export interface CompleteIndexRunResult {
  readonly runId: string;
  readonly removed: number;
}

export interface IndexStatus {
  readonly runId: string;
  readonly namespace: string;
  readonly total: number;
  readonly pendingDiff: number;
  readonly unchanged: number;
  readonly pendingMaterialize: number;
  readonly pendingEmbed: number;
  readonly committed: number;
  readonly failed: number;
}

export interface IndexRunResult {
  readonly namespace: string;
  readonly total: number;
  readonly reembedded: number;
  readonly unchanged: number;
  readonly removed: number;
}

const DEFAULT_PAGE_LIMIT = 25;
const DEFAULT_MATERIALIZE_CONCURRENCY = 1;
const DEFAULT_EMBED_MAX_CHUNKS = 128;
const DEFAULT_EMBED_MAX_ESTIMATED_INPUT_TOKENS = 64_000;
const DEFAULT_EMBED_MAX_ESTIMATED_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_EMBED_MAX_ESTIMATED_TOKENS_PER_TEXT = 2_048;
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

const queryJobs = (
  deps: IndexCollections,
  input: {
    readonly runId: string;
    readonly partition: number;
    readonly status: IndexJob["status"];
    readonly limit?: number;
  },
): Effect.Effect<
  readonly { readonly key: string; readonly data: IndexJob }[],
  SemanticSearchError
> =>
  deps.jobs
    .query({
      where: { runId: input.runId, partition: input.partition, status: input.status },
      orderBy: [{ field: "ordinal", direction: "asc" }],
      limit: input.limit ?? DEFAULT_PAGE_LIMIT,
    })
    .pipe(
      Effect.mapError(
        (cause) => new SemanticSearchError({ message: "Failed to query index jobs.", cause }),
      ),
    );

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

interface EmbedBudget {
  readonly maxChunks: number;
  readonly maxEstimatedInputTokens: number;
  readonly maxEstimatedResponseBytes: number;
  readonly maxEstimatedTokensPerText: number;
}

const resolveEmbedBudget = (input: IndexPageInput): EmbedBudget => ({
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

export const startIndexRun = (
  input: IndexStores & StartIndexRunInput,
): Effect.Effect<StartIndexRunResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const partitionCount = Math.max(1, Math.floor(input.partitionCount));
    const descriptors = yield* listToolDescriptors(input.executor);
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

export const seedIndexPartitionPage = (
  input: IndexStores & IndexPageInput,
): Effect.Effect<IndexDiffPageResult, SemanticSearchError> =>
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

    const descriptors = yield* listToolDescriptors(input.executor);
    const partitionDescriptors = descriptors
      .map((tool, ordinal) => ({ tool, ordinal, path: addressToPath(String(tool.address)) }))
      .filter(({ path }) => partitionForPath(path, run.data.partitionCount) === input.partition);
    const existing = yield* input.jobs
      .count({ where: { runId: input.runId, partition: input.partition } })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SemanticSearchError({ message: "Failed to count seeded index jobs.", cause }),
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
        unchanged: 0,
      };
    }

    const createdAt = nowIso();
    yield* Effect.forEach(
      selected,
      ({ tool, ordinal, path }) => {
        const job: IndexJob = {
          runId: input.runId,
          namespace: input.namespace,
          partition: input.partition,
          ordinal,
          address: String(tool.address),
          path,
          name: String(tool.name),
          integration: String(tool.integration),
          description: String(tool.description ?? ""),
          status: "pendingDiff",
          oldChunkIds: [],
          chunkIds: [],
          createdAt,
          updatedAt: createdAt,
        };
        return putJob(input, job);
      },
      { concurrency: 1, discard: true },
    );

    return {
      runId: input.runId,
      partition: input.partition,
      processed: selected.length,
      changed: 0,
      unchanged: 0,
    };
  });

export const diffIndexPartitionPage = (
  input: IndexStores & IndexPageInput,
): Effect.Effect<IndexDiffPageResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const jobs = yield* queryJobs(input, {
      runId: input.runId,
      partition: input.partition,
      status: "pendingDiff",
      limit: input.limit,
    });
    if (jobs.length === 0) {
      return {
        runId: input.runId,
        partition: input.partition,
        processed: 0,
        changed: 0,
        unchanged: 0,
      };
    }

    const fingerprintInputs = yield* collectFingerprintInputs(
      input.executor,
      jobs.map((entry) => jobToDescriptor(entry.data)),
    );
    const stored = yield* loadFingerprints(
      input,
      fingerprintInputs.map(({ input: fp }) => fp.path),
    );

    let changed = 0;
    let unchanged = 0;
    const byPath = new Map(jobs.map((entry) => [entry.data.path, entry.data]));
    const updatedAt = nowIso();

    yield* Effect.forEach(
      fingerprintInputs,
      ({ input: fp }) => {
        const job = byPath.get(fp.path);
        if (job === undefined) return Effect.void;
        const fingerprint = fingerprintTool(fp);
        const storedRow = stored.get(fp.path);
        const next: IndexJob =
          storedRow !== undefined && storedRow.fingerprint === fingerprint
            ? {
                ...job,
                status: "unchanged",
                fingerprint,
                oldChunkIds: storedRow.chunkIds,
                chunkIds: storedRow.chunkIds,
                updatedAt,
              }
            : {
                ...job,
                status: "pendingMaterialize",
                fingerprint,
                oldChunkIds: storedRow?.chunkIds ?? [],
                chunkIds: [],
                updatedAt,
              };
        if (next.status === "unchanged") unchanged++;
        else changed++;
        return putJob(input, next);
      },
      { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
    );

    return {
      runId: input.runId,
      partition: input.partition,
      processed: jobs.length,
      changed,
      unchanged,
    };
  });

export const materializeIndexPartitionPage = (
  input: IndexDeps & IndexPageInput,
): Effect.Effect<IndexMaterializePageResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const jobs = yield* queryJobs(input, {
      runId: input.runId,
      partition: input.partition,
      status: "pendingMaterialize",
      limit: input.limit,
    });
    if (jobs.length === 0) {
      return { runId: input.runId, partition: input.partition, processed: 0, chunks: 0 };
    }

    const updatedAt = nowIso();
    const materializeConcurrency = Math.max(
      1,
      Math.floor(input.materializeConcurrency ?? DEFAULT_MATERIALIZE_CONCURRENCY),
    );

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
          yield* putJob(input, {
            ...job,
            status: "pendingEmbed",
            chunkIds: chunks.map((chunk) => chunk.id),
            lexicalTextKey,
            updatedAt,
          });
          return chunks.length;
        }),
      { concurrency: materializeConcurrency },
    );
    const chunkCount = chunkCounts.reduce((sum, count) => sum + count, 0);

    return {
      runId: input.runId,
      partition: input.partition,
      processed: jobs.length,
      chunks: chunkCount,
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
        status: "pendingEmbed",
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

export const embedIndexPartitionPage = (
  input: IndexDeps & IndexPageInput,
): Effect.Effect<IndexEmbedPageResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const budget = resolveEmbedBudget(input);
    const jobs = yield* queryJobs(input, {
      runId: input.runId,
      partition: input.partition,
      status: "pendingEmbed",
      limit: input.limit,
    });
    if (jobs.length === 0) {
      return { runId: input.runId, partition: input.partition, processed: 0, chunks: 0 };
    }

    const chunkEntriesByPath = new Map<
      string,
      readonly { readonly key: string; readonly data: IndexChunk }[]
    >();
    for (const jobEntry of jobs) {
      chunkEntriesByPath.set(jobEntry.data.path, yield* queryChunksForJob(input, jobEntry.data));
    }

    const selectedChunks: { readonly key: string; readonly data: IndexChunk }[] = [];
    const vectorResponseBytes = estimateEmbeddingResponseBytes(input.embedder.dimensions);
    let selectedInputTokens = 0;
    let selectedResponseBytes = 0;
    let budgetFull = false;

    for (const { data: job } of jobs) {
      if (budgetFull) break;
      const pending = (chunkEntriesByPath.get(job.path) ?? []).filter(
        (entry) => entry.data.status === "pendingEmbed",
      );
      for (const entry of pending) {
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
          budgetFull = true;
          break;
        }

        selectedChunks.push(entry);
        selectedInputTokens += inputTokens;
        selectedResponseBytes += vectorResponseBytes;
      }
    }

    if (selectedChunks.length === 0) {
      const finalized = yield* finalizeCompletedEmbedJobs(
        input,
        jobs,
        chunkEntriesByPath,
        nowIso(),
      );
      return {
        runId: input.runId,
        partition: input.partition,
        processed: finalized,
        chunks: 0,
      };
    }

    const selectedTexts = yield* Effect.forEach(
      selectedChunks,
      (entry) => getPayloadText(input, entry.data.embeddingTextKey),
      { concurrency: INDEX_STORAGE_CONCURRENCY },
    );
    const vectors = yield* input.embedder.embedDocuments(selectedTexts);
    const records: VectorInput[] = [];
    for (let i = 0; i < selectedChunks.length; i++) {
      const chunk = selectedChunks[i]?.data;
      const vec = vectors[i];
      if (chunk === undefined || vec === undefined) {
        return yield* new SemanticSearchError({
          message: `embedIndexPartitionPage: embedding vector missing at offset ${i}`,
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

    if (records.length > 0) {
      yield* input.store.upsert(records);
    }

    const updatedAt = nowIso();
    yield* Effect.forEach(
      selectedChunks,
      (entry) =>
        input.chunks
          .put({
            owner: input.owner,
            key: entry.key,
            data: { ...entry.data, status: "committed", updatedAt },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SemanticSearchError({
                  message: `Failed to mark chunk "${entry.data.chunkId}" committed.`,
                  cause,
                }),
            ),
          ),
      { concurrency: INDEX_STORAGE_CONCURRENCY, discard: true },
    );

    const affectedPaths = new Set(selectedChunks.map((entry) => entry.data.path));
    const finalizationCandidates = jobs.filter(({ data: job }) => {
      if (affectedPaths.has(job.path)) return true;
      return !(chunkEntriesByPath.get(job.path) ?? []).some(
        (entry) => entry.data.status === "pendingEmbed",
      );
    });
    const finalized = yield* finalizeCompletedEmbedJobs(
      input,
      finalizationCandidates,
      undefined,
      updatedAt,
    );

    return {
      runId: input.runId,
      partition: input.partition,
      processed: Math.max(affectedPaths.size, finalized),
      chunks: records.length,
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
    let finalized = 0;
    for (const { data: job } of jobs) {
      const chunkEntries = preloadedChunks?.get(job.path) ?? (yield* queryChunksForJob(input, job));
      if (chunkEntries.some((entry) => entry.data.status !== "committed")) {
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
        yield* input.store.deleteByIds([...job.oldChunkIds]);
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

      yield* putJob(input, { ...job, status: "committed", updatedAt });
      finalized++;
    }
    return finalized;
  });

export const indexRunStatus = (
  input: IndexCollections & { readonly namespace: string; readonly runId: string },
): Effect.Effect<IndexStatus, SemanticSearchError> =>
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
    const [pendingDiff, unchanged, pendingMaterialize, pendingEmbed, committed, failed] =
      yield* Effect.all(
        [
          count("pendingDiff"),
          count("unchanged"),
          count("pendingMaterialize"),
          count("pendingEmbed"),
          count("committed"),
          count("failed"),
        ],
        { concurrency: INDEX_STORAGE_CONCURRENCY },
      );
    return {
      runId: input.runId,
      namespace: run?.data.namespace ?? input.namespace,
      total:
        run?.data.total ??
        pendingDiff + unchanged + pendingMaterialize + pendingEmbed + committed + failed,
      pendingDiff,
      unchanged,
      pendingMaterialize,
      pendingEmbed,
      committed,
      failed,
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
            yield* input.store.deleteByIds([...entry.data.chunkIds]);
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

export const completeIndexRun = (
  input: IndexDeps & { readonly runId: string },
  sweep: Effect.Effect<{ readonly removed: number }, SemanticSearchError>,
): Effect.Effect<CompleteIndexRunResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const result = yield* sweep;
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

export const runIndexRun = (
  input: IndexDeps & {
    readonly runId: string;
    readonly partitionCount: number;
    readonly pageLimit?: number;
  },
): Effect.Effect<IndexRunResult, SemanticSearchError> =>
  Effect.gen(function* () {
    const started = yield* startIndexRun(input);
    for (let partition = 0; partition < started.partitionCount; partition++) {
      for (;;) {
        const page = yield* seedIndexPartitionPage({
          ...input,
          partition,
          limit: input.pageLimit,
        });
        if (page.processed === 0) break;
      }
    }
    for (let partition = 0; partition < started.partitionCount; partition++) {
      for (;;) {
        const page = yield* diffIndexPartitionPage({
          ...input,
          partition,
          limit: input.pageLimit,
        });
        if (page.processed === 0) break;
      }
    }
    for (let partition = 0; partition < started.partitionCount; partition++) {
      for (;;) {
        const page = yield* materializeIndexPartitionPage({
          ...input,
          partition,
          limit: input.pageLimit,
        });
        if (page.processed === 0) break;
      }
    }
    for (let partition = 0; partition < started.partitionCount; partition++) {
      for (;;) {
        const page = yield* embedIndexPartitionPage({
          ...input,
          partition,
          limit: input.pageLimit,
        });
        if (page.processed === 0) break;
      }
    }
    const completed = yield* completeIndexRun(
      input,
      sweepRemoved({
        namespace: input.namespace,
        executor: input.executor,
        store: input.store,
        fingerprints: input.fingerprints,
        owner: input.owner,
        lexicalStore: input.lexicalStore,
      }),
    );
    const status = yield* indexRunStatus(input);
    return {
      namespace: input.namespace,
      total: status.total,
      reembedded: status.committed,
      unchanged: status.unchanged,
      removed: completed.removed,
    };
  });
