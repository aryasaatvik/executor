import { describe, expect, it } from "@effect/vitest";
import type {
  Executor,
  Owner,
  PluginStorageCollectionFacade,
  PluginStorageEntry,
  Tool,
  ToolSchemaManifest,
} from "@executor-js/sdk/core";
import { makeInMemoryBlobStore, pluginBlobStore } from "@executor-js/sdk/core";
import { Effect } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";

import { makeFacetChunker } from "./chunker";
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
import type { ToolEmbedder } from "./embedder";
import { SemanticSearchError } from "./errors";
import {
  chunk,
  commit,
  complete,
  create,
  embed,
  fail,
  reconcile,
  scan,
  status,
} from "./tool-search-index";
import type { VectorInput, VectorStore } from "./store";

const owner: Owner = "org" as Owner;
const namespace = "test-ns";

const makeBlobs = () =>
  pluginBlobStore(makeInMemoryBlobStore(), { org: "test-org", user: null }, "semanticSearch");

/** In-memory cache primitive for the executor mock — durable within a single test
 *  so a `create` snapshot write is visible to the `scan` reads that follow. */
const makeMemoryCache = (): Executor["cache"] => {
  const rows = new Map<string, string>();
  return KeyValueStore.makeStringOnly({
    get: (key) => Effect.sync(() => rows.get(key)),
    set: (key, value) =>
      Effect.sync(() => {
        rows.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        rows.delete(key);
      }),
    clear: Effect.sync(() => {
      rows.clear();
    }),
    size: Effect.sync(() => rows.size),
  });
};

const manifestForTool = (
  tool: Tool,
  fingerprint = `fingerprint:${String(tool.address)}`,
  sourceRevision?: string,
): ToolSchemaManifest => ({
  address: tool.address,
  path: String(tool.address).replace(/^tools\./, ""),
  owner,
  integration: String(tool.integration),
  connection: String(tool.connection),
  pluginId: tool.pluginId,
  name: String(tool.name),
  description: tool.description ?? "",
  descriptorHash: `descriptor:${String(tool.address)}`,
  inputSchemaHash: `input:${String(tool.address)}`,
  outputSchemaHash: `output:${String(tool.address)}`,
  definitionSetHash: `definitions:${String(tool.address)}`,
  indexFingerprint: fingerprint,
  fingerprintVersion: "tool-schema-manifest/v1",
  ...(sourceRevision === undefined ? {} : { sourceRevision }),
});

const makeExecutor = (
  counters: { raw: number; codegen: number },
  options?: { readonly description?: string },
): Executor => {
  const tool: Tool = {
    address: "tools.github.repos.get" as never,
    name: "repos.get" as never,
    integration: "github" as never,
    description: options?.description ?? "Get a repository",
    owner,
    connection: "default" as never,
    pluginId: "test",
  };
  const executor: Pick<Executor, "tools" | "cache"> = {
    tools: {
      list: () => Effect.succeed([tool]),
      manifest: () => Effect.succeed([manifestForTool(tool)]),
      schema: (address) => {
        counters.codegen++;
        return Effect.succeed({
          address,
          inputSchema: { type: "object", properties: { owner: { type: "string" } } },
          inputTypeScript: "{ owner: string }",
        });
      },
    },
    cache: makeMemoryCache(),
  };
  return executor as Executor;
};

type TestCollection<T extends object> = PluginStorageCollectionFacade<any> & {
  readonly data: Map<string, T>;
};

type TestAggregateValue = string | number | boolean | null;

const makeCollection = <T extends object>(collection: string): TestCollection<T> => {
  const data = new Map<string, T>();
  let id = 0;
  const entry = (key: string, value: T): PluginStorageEntry<T> => ({
    id: String(id++),
    owner,
    pluginId: "semanticSearch",
    collection,
    key,
    data: value,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const matches = (value: T, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      const actual = (value as Record<string, unknown>)[key];
      if (
        typeof expected === "object" &&
        expected !== null &&
        "in" in expected &&
        Array.isArray((expected as { readonly in?: unknown }).in)
      ) {
        return (expected as { readonly in: readonly unknown[] }).in.includes(actual);
      }
      return actual === expected;
    });
  };
  const facade = {
    data,
    get: ({ key }: { key: string }) =>
      Effect.succeed(data.has(key) ? entry(key, data.get(key)!) : null),
    getMany: ({ keys }: { keys: readonly string[] }) =>
      Effect.succeed(
        new Map(
          keys.flatMap((key) => {
            const value = data.get(key);
            return value === undefined ? [] : [[key, entry(key, value)] as const];
          }),
        ),
      ),
    getForOwner: ({ key }: { key: string }) =>
      Effect.succeed(data.has(key) ? entry(key, data.get(key)!) : null),
    getManyForOwner: ({ keys }: { keys: readonly string[] }) =>
      Effect.succeed(
        new Map(
          keys.flatMap((key) => {
            const value = data.get(key);
            return value === undefined ? [] : [[key, entry(key, value)] as const];
          }),
        ),
      ),
    list: () => Effect.succeed([...data.entries()].map(([key, value]) => entry(key, value))),
    put: ({ key, data: value }: { key: string; data: T }) =>
      Effect.sync(() => {
        data.set(key, value);
        return entry(key, value);
      }),
    putMany: ({ entries }: { entries: readonly { readonly key: string; readonly data: T }[] }) =>
      Effect.sync(() => {
        for (const item of entries) data.set(item.key, item.data);
      }),
    query: (input?: {
      where?: Record<string, unknown>;
      orderBy?: readonly { readonly field: string; readonly direction?: "asc" | "desc" }[];
      limit?: number;
    }) =>
      Effect.succeed(
        [...data.entries()]
          .filter(([, value]) => matches(value, input?.where))
          .sort(([leftKey, left], [rightKey, right]) => {
            for (const order of input?.orderBy ?? []) {
              const direction = order.direction === "desc" ? -1 : 1;
              const a = (left as Record<string, unknown>)[order.field];
              const b = (right as Record<string, unknown>)[order.field];
              if (typeof a === "number" && typeof b === "number" && a !== b)
                return (a - b) * direction;
              if (String(a) !== String(b)) return String(a).localeCompare(String(b)) * direction;
            }
            return leftKey.localeCompare(rightKey);
          })
          .slice(0, input?.limit)
          .map(([key, value]) => entry(key, value)),
      ),
    count: (input?: { where?: Record<string, unknown> }) =>
      Effect.succeed([...data.values()].filter((value) => matches(value, input?.where)).length),
    queryKeyset: () => Effect.succeed({ entries: [], nextCursor: null }),
    aggregate: {
      count: () => Effect.succeed(data.size),
      groupCount: (input: { field: string; where?: Record<string, unknown> }) =>
        Effect.succeed(
          [
            ...[...data.values()]
              .filter((value) => matches(value, input.where))
              .reduce((counts, value) => {
                const fieldValue = (value as Record<string, unknown>)[input.field];
                if (
                  typeof fieldValue === "string" ||
                  typeof fieldValue === "number" ||
                  typeof fieldValue === "boolean" ||
                  fieldValue === null
                ) {
                  counts.set(fieldValue, (counts.get(fieldValue) ?? 0) + 1);
                }
                return counts;
              }, new Map<TestAggregateValue, number>()),
          ].map(([value, count]) => ({ value, count })),
        ),
      timeBuckets: () => Effect.succeed([]),
      stats: () => Effect.succeed({ count: 0, min: null, max: null, percentiles: [] }),
    },
    remove: ({ key }: { key: string }) => Effect.sync(() => data.delete(key)),
    removeMany: ({ keys }: { keys: readonly string[] }) =>
      Effect.sync(() => {
        for (const key of keys) data.delete(key);
      }),
  };
  // oxlint-disable-next-line executor/no-double-cast -- test fixture implements the storage facade methods exercised by these indexer tests
  return facade as unknown as TestCollection<T>;
};

describe("ToolSearchIndex", () => {
  it.effect("scans, chunks, embeds, and commits changed tools", () =>
    Effect.gen(function* () {
      const counters = { raw: 0, codegen: 0 };
      const executor = makeExecutor(counters, { description: "Get a repository ".repeat(700) });
      const runs = makeCollection<IndexRun>(indexRuns.name);
      const jobs = makeCollection<IndexJob>(indexJobs.name);
      const chunks = makeCollection<IndexChunk>(indexChunks.name);
      const fingerprints = makeCollection<FingerprintRow>(toolFingerprints.name);
      const blobs = makeBlobs();
      const path = "github.repos.get";
      const oldFingerprint = "fingerprint:old";
      const nextFingerprint = "fingerprint:tools.github.repos.get";
      yield* fingerprints.put({
        owner,
        key: path,
        data: {
          path,
          integration: "github",
          fingerprint: oldFingerprint,
          chunkIds: ["old-chunk"],
        },
      });
      yield* blobs.put(
        `semantic-search/index/document/v1/${oldFingerprint}.json`,
        JSON.stringify({
          path,
          name: "repos.get",
          integration: "github",
          description: "old",
        }),
        { owner },
      );
      const upserted: VectorInput[] = [];
      const deleted: string[][] = [];
      const store: VectorStore = {
        maxTopK: 100,
        query: () => Effect.succeed([]),
        upsert: (vectors) => Effect.sync(() => void upserted.push(...vectors)),
        deleteByIds: (ids) => Effect.sync(() => void deleted.push([...ids])),
      };
      const embedder: ToolEmbedder = {
        model: "test",
        dimensions: 3,
        embedDocuments: (texts) => Effect.succeed(texts.map(() => [0.1, 0.2, 0.3])),
        embedQuery: () => Effect.succeed([0.1, 0.2, 0.3]),
      };

      const base = { namespace, executor, runs, jobs, chunks, fingerprints, blobs, owner };
      yield* create({ ...base, runId: "run-1", partitionCount: 1 });
      const scanned = yield* scan({
        ...base,
        runId: "run-1",
        partition: 0,
        limit: 10,
      });
      const chunked = yield* chunk({
        ...base,
        embedder,
        store,
        chunker: makeFacetChunker(),
        runId: "run-1",
        paths: scanned.paths,
        limit: 10,
      });
      const embedded = yield* embed({
        ...base,
        embedder,
        store,
        chunker: makeFacetChunker(),
        runId: "run-1",
        chunkRefs: chunked.chunkRefs,
      });
      if (embedded.paths.length > 0) {
        yield* commit({
          ...base,
          embedder,
          store,
          chunker: makeFacetChunker(),
          runId: "run-1",
          paths: embedded.paths,
        });
      }

      expect(scanned).toMatchObject({ processed: 1, changed: 1, skipped: 0 });
      expect([...jobs.data.values()][0]?.sourceRevision).toBeUndefined();
      expect(chunked.processed).toBe(1);
      expect(chunked.chunks).toBeGreaterThan(0);
      expect(embedded).toMatchObject({ processed: chunked.chunks, chunks: chunked.chunks });
      expect(counters).toEqual({ raw: 0, codegen: 1 });
      expect(upserted).toHaveLength(chunked.chunks);
      for (const vector of upserted) {
        expect(
          Buffer.byteLength(String(vector.metadata?.description ?? ""), "utf8"),
        ).toBeLessThanOrEqual(2_048);
      }
      expect([...fingerprints.data.values()]).toHaveLength(1);
      expect(fingerprints.data.get(path)?.fingerprint).toBe(nextFingerprint);
      expect(yield* blobs.has(`semantic-search/index/document/v1/${oldFingerprint}.json`)).toBe(
        false,
      );
      expect(yield* blobs.has(`semantic-search/index/document/v1/${nextFingerprint}.json`)).toBe(
        true,
      );
      expect(deleted).toEqual([["old-chunk"]]);
      expect([...jobs.data.values()][0]?.status).toBe("indexed");
    }),
  );

  it.effect("copies manifest source revisions into scan jobs", () =>
    Effect.gen(function* () {
      const tool: Tool = {
        address: "tools.github.repos.get" as never,
        name: "repos.get" as never,
        integration: "github" as never,
        description: "Get a repository",
        owner,
        connection: "default" as never,
        pluginId: "test",
      };
      const executor: Pick<Executor, "tools" | "cache"> = {
        tools: {
          list: () => Effect.succeed([tool]),
          manifest: () => Effect.succeed([manifestForTool(tool, "fp-source", "spec-hash-v1")]),
          schema: () => Effect.succeed(null),
        },
        cache: makeMemoryCache(),
      };
      const base = {
        namespace,
        executor: executor as Executor,
        runs: makeCollection<IndexRun>(indexRuns.name),
        jobs: makeCollection<IndexJob>(indexJobs.name),
        chunks: makeCollection<IndexChunk>(indexChunks.name),
        fingerprints: makeCollection<FingerprintRow>(toolFingerprints.name),
        blobs: makeBlobs(),
        owner,
      };

      yield* create({ ...base, runId: "run-source-revision", partitionCount: 1 });
      const scanned = yield* scan({
        ...base,
        runId: "run-source-revision",
        partition: 0,
        limit: 10,
      });

      expect(scanned).toMatchObject({ processed: 1, changed: 1, skipped: 0 });
      expect([...base.jobs.data.values()][0]).toMatchObject({
        path: "github.repos.get",
        fingerprint: "fp-source",
        sourceRevision: "spec-hash-v1",
      });

      const skippedBase = {
        ...base,
        jobs: makeCollection<IndexJob>(indexJobs.name),
        fingerprints: makeCollection<FingerprintRow>(toolFingerprints.name),
      };
      yield* skippedBase.fingerprints.put({
        owner,
        key: "github.repos.get",
        data: {
          path: "github.repos.get",
          integration: "github",
          fingerprint: "fp-source",
          chunkIds: [],
        },
      });

      yield* create({ ...skippedBase, runId: "run-source-revision-skipped", partitionCount: 1 });
      const skipped = yield* scan({
        ...skippedBase,
        runId: "run-source-revision-skipped",
        partition: 0,
        limit: 10,
      });

      expect(skipped).toMatchObject({ processed: 1, changed: 0, skipped: 1 });
      expect([...skippedBase.jobs.data.values()][0]).toMatchObject({
        path: "github.repos.get",
        fingerprint: "fp-source",
        sourceRevision: "spec-hash-v1",
      });
    }),
  );

  it.effect("marks pending path work failed and reports progress timestamps", () =>
    Effect.gen(function* () {
      const counters = { raw: 0, codegen: 0 };
      const executor = makeExecutor(counters);
      const runs = makeCollection<IndexRun>(indexRuns.name);
      const jobs = makeCollection<IndexJob>(indexJobs.name);
      const chunks = makeCollection<IndexChunk>(indexChunks.name);
      const fingerprints = makeCollection<FingerprintRow>(toolFingerprints.name);
      const blobs = makeBlobs();
      const store: VectorStore = {
        maxTopK: 100,
        query: () => Effect.succeed([]),
        upsert: () => Effect.void,
        deleteByIds: () => Effect.void,
      };
      const embedder: ToolEmbedder = {
        model: "test",
        dimensions: 3,
        embedDocuments: (texts) => Effect.succeed(texts.map(() => [0.1, 0.2, 0.3])),
        embedQuery: () => Effect.succeed([0.1, 0.2, 0.3]),
      };

      const base = { namespace, executor, runs, jobs, chunks, fingerprints, blobs, owner };
      yield* create({ ...base, runId: "run-fail", partitionCount: 1 });
      const scanned = yield* scan({
        ...base,
        runId: "run-fail",
        partition: 0,
        limit: 10,
      });
      yield* chunk({
        ...base,
        embedder,
        store,
        chunker: makeFacetChunker(),
        runId: "run-fail",
        paths: scanned.paths,
        limit: 10,
      });

      const result = yield* fail({
        ...base,
        runId: "run-fail",
        paths: scanned.paths,
        error: "queue exhausted",
      });
      const current = yield* status({ ...base, runId: "run-fail" });

      expect(result.jobs).toBe(1);
      expect(result.chunks).toBeGreaterThan(0);
      expect(result.runFailed).toBe(false);
      expect([...jobs.data.values()][0]?.status).toBe("failed");
      expect([...chunks.data.values()].every((chunk) => chunk.status === "failed")).toBe(true);
      expect(current.failed).toBe(1);
      expect(current.lastProgressAt).toBeDefined();
    }),
  );

  it.effect("reconciles pending scan partitions, chunk paths, embedding chunks, and commits", () =>
    Effect.gen(function* () {
      const counters = { raw: 0, codegen: 0 };
      const executor = makeExecutor(counters);
      const runs = makeCollection<IndexRun>(indexRuns.name);
      const jobs = makeCollection<IndexJob>(indexJobs.name);
      const chunks = makeCollection<IndexChunk>(indexChunks.name);
      const fingerprints = makeCollection<FingerprintRow>(toolFingerprints.name);
      const blobs = makeBlobs();
      const base = { namespace, executor, runs, jobs, chunks, fingerprints, blobs, owner };

      yield* create({ ...base, runId: "run-reconcile", partitionCount: 1 });
      const beforeScan = yield* reconcile({ ...base, runId: "run-reconcile" });
      const scanned = yield* scan({
        ...base,
        runId: "run-reconcile",
        partition: 0,
        limit: 10,
      });
      const afterScan = yield* reconcile({ ...base, runId: "run-reconcile" });

      expect(beforeScan.scanPartitions).toEqual([0]);
      expect(afterScan.pendingChunkPaths).toEqual(scanned.paths);
      expect(afterScan.scanPartitions).toEqual([]);
    }),
  );

  it.effect("preserves the run's maxTools cap through reconcile", () =>
    Effect.gen(function* () {
      const counters = { raw: 0, codegen: 0 };
      const executor = makeExecutor(counters);
      const runs = makeCollection<IndexRun>(indexRuns.name);
      const jobs = makeCollection<IndexJob>(indexJobs.name);
      const chunks = makeCollection<IndexChunk>(indexChunks.name);
      const fingerprints = makeCollection<FingerprintRow>(toolFingerprints.name);
      const blobs = makeBlobs();
      const base = { namespace, executor, runs, jobs, chunks, fingerprints, blobs, owner };

      yield* create({ ...base, runId: "run-capped", partitionCount: 1, maxTools: 1 });
      const capped = yield* reconcile({ ...base, runId: "run-capped" });
      expect(capped.maxTools).toBe(1);

      yield* create({ ...base, runId: "run-uncapped", partitionCount: 1 });
      const uncapped = yield* reconcile({ ...base, runId: "run-uncapped" });
      expect(uncapped.maxTools).toBeUndefined();
    }),
  );

  it.effect(
    "reconstructs embed messages when a chunk message retries after persisting chunks",
    () =>
      Effect.gen(function* () {
        const counters = { raw: 0, codegen: 0 };
        const executor = makeExecutor(counters);
        const runs = makeCollection<IndexRun>(indexRuns.name);
        const jobs = makeCollection<IndexJob>(indexJobs.name);
        const chunks = makeCollection<IndexChunk>(indexChunks.name);
        const fingerprints = makeCollection<FingerprintRow>(toolFingerprints.name);
        const blobs = makeBlobs();
        const store: VectorStore = {
          maxTopK: 100,
          query: () => Effect.succeed([]),
          upsert: () => Effect.void,
          deleteByIds: () => Effect.void,
        };
        const embedder: ToolEmbedder = {
          model: "test",
          dimensions: 3,
          embedDocuments: (texts) => Effect.succeed(texts.map(() => [0.1, 0.2, 0.3])),
          embedQuery: () => Effect.succeed([0.1, 0.2, 0.3]),
        };
        const base = { namespace, executor, runs, jobs, chunks, fingerprints, blobs, owner };

        yield* create({ ...base, runId: "run-chunk-retry", partitionCount: 1 });
        const scanned = yield* scan({
          ...base,
          runId: "run-chunk-retry",
          partition: 0,
          limit: 10,
        });
        const first = yield* chunk({
          ...base,
          embedder,
          store,
          chunker: makeFacetChunker(),
          runId: "run-chunk-retry",
          paths: scanned.paths,
          limit: 10,
        });
        const retry = yield* chunk({
          ...base,
          embedder,
          store,
          chunker: makeFacetChunker(),
          runId: "run-chunk-retry",
          paths: scanned.paths,
          limit: 10,
        });

        expect(first.chunkRefs.length).toBeGreaterThan(0);
        expect(retry.chunkRefs).toEqual(first.chunkRefs);
        expect(retry.commitPaths).toEqual([]);
        expect(counters).toEqual({ raw: 0, codegen: 1 });
      }),
  );

  it.effect("limits seeded tools when maxTools is provided", () =>
    Effect.gen(function* () {
      const tools: readonly Tool[] = [
        {
          address: "tools.github.repos.get" as never,
          name: "repos.get" as never,
          integration: "github" as never,
          description: "Get a repository",
          owner,
          connection: "default" as never,
          pluginId: "test",
        },
        {
          address: "tools.stripe.customers.list" as never,
          name: "customers.list" as never,
          integration: "stripe" as never,
          description: "List customers",
          owner,
          connection: "default" as never,
          pluginId: "test",
        },
        {
          address: "tools.slack.chat.postMessage" as never,
          name: "chat.postMessage" as never,
          integration: "slack" as never,
          description: "Post a message",
          owner,
          connection: "default" as never,
          pluginId: "test",
        },
      ];
      const executor: Pick<Executor, "tools" | "cache"> = {
        tools: {
          list: () => Effect.succeed(tools),
          manifest: () => Effect.succeed(tools.map((tool) => manifestForTool(tool))),
          schema: () => Effect.succeed(null),
        },
        cache: makeMemoryCache(),
      };
      const runs = makeCollection<IndexRun>(indexRuns.name);
      const jobs = makeCollection<IndexJob>(indexJobs.name);
      const chunks = makeCollection<IndexChunk>(indexChunks.name);
      const fingerprints = makeCollection<FingerprintRow>(toolFingerprints.name);
      const blobs = makeBlobs();
      const base = {
        namespace,
        executor: executor as Executor,
        runs,
        jobs,
        chunks,
        fingerprints,
        blobs,
        owner,
      };

      const started = yield* create({
        ...base,
        runId: "run-limited",
        partitionCount: 1,
        maxTools: 2,
      });
      const scanned = yield* scan({
        ...base,
        runId: "run-limited",
        partition: 0,
        limit: 10,
        maxTools: 2,
      });

      expect(started.total).toBe(2);
      expect(scanned.processed).toBe(2);
      expect(jobs.data.size).toBe(2);
    }),
  );

  it.effect("embeds only the chunks that fit the page budget and commits the job later", () =>
    Effect.gen(function* () {
      const runs = makeCollection<IndexRun>(indexRuns.name);
      const jobs = makeCollection<IndexJob>(indexJobs.name);
      const chunks = makeCollection<IndexChunk>(indexChunks.name);
      const fingerprints = makeCollection<FingerprintRow>(toolFingerprints.name);
      const blobs = makeBlobs();
      const mutableEmbeddedGroups: string[][] = [];
      const upserted: VectorInput[] = [];
      const store: VectorStore = {
        maxTopK: 100,
        query: () => Effect.succeed([]),
        upsert: (vectors) => Effect.sync(() => void upserted.push(...vectors)),
        deleteByIds: () => Effect.void,
      };
      const embedder: ToolEmbedder = {
        model: "test",
        dimensions: 3,
        embedDocuments: (texts) =>
          Effect.sync(() => {
            mutableEmbeddedGroups.push([...texts]);
            return texts.map(() => [0.1, 0.2, 0.3]);
          }),
        embedQuery: () => Effect.succeed([0.1, 0.2, 0.3]),
      };

      const createdAt = new Date(0).toISOString();
      const job: IndexJob = {
        runId: "run-budget",
        namespace,
        partition: 0,
        ordinal: 0,
        address: "tools.github.repos.get",
        path: "github.repos.get",
        name: "repos.get",
        integration: "github",
        description: "Get a repository",
        status: "pendingEmbedding",
        fingerprint: "fp-budget",
        oldChunkIds: [],
        chunkIds: ["chunk-0", "chunk-1", "chunk-2"],
        lexicalTextKey: "test/lexical.txt",
        createdAt,
        updatedAt: createdAt,
      };
      yield* blobs.put("test/lexical.txt", "github github.repos.get repos.get", { owner });
      yield* jobs.put({ owner, key: `${job.runId}:${job.path}`, data: job });
      yield* Effect.forEach(
        job.chunkIds,
        (chunkId, chunkIndex) =>
          Effect.gen(function* () {
            const embeddingText = `chunk text ${chunkIndex}`;
            const chunk: IndexChunk = {
              runId: job.runId,
              namespace,
              partition: 0,
              path: job.path,
              chunkId,
              facet: "description",
              chunkIndex,
              embeddingTextKey: `test/${chunkId}.txt`,
              embeddingTextBytes: embeddingText.length,
              embeddingTextTokens: 3,
              name: job.name,
              integration: job.integration,
              description: job.description,
              status: "pendingEmbedding",
              createdAt,
              updatedAt: createdAt,
            };
            yield* blobs.put(chunk.embeddingTextKey, embeddingText, { owner });
            yield* chunks.put({
              owner,
              key: `${chunk.runId}:${chunk.path}:${chunk.chunkId}`,
              data: chunk,
            });
          }),
        { discard: true },
      );

      const base = {
        namespace,
        executor: makeExecutor({ raw: 0, codegen: 0 }),
        runs,
        jobs,
        chunks,
        fingerprints,
        blobs,
        owner,
        embedder,
        store,
        chunker: makeFacetChunker(),
      };

      const first = yield* embed({
        ...base,
        runId: job.runId,
        chunkRefs: job.chunkIds.map((chunkId) => ({ path: job.path, chunkId })),
        maxChunks: 2,
      });
      const afterFirstJob = jobs.data.get(`${job.runId}:${job.path}`);
      const firstChunkStatuses = [...chunks.data.values()].map((chunk) => chunk.status);

      const second = yield* embed({
        ...base,
        runId: job.runId,
        chunkRefs: job.chunkIds.map((chunkId) => ({ path: job.path, chunkId })),
        maxChunks: 10,
      });
      const committed = yield* commit({ ...base, runId: job.runId, paths: [job.path] });
      const afterCommitJob = jobs.data.get(`${job.runId}:${job.path}`);

      expect(first).toMatchObject({ processed: 2, chunks: 2 });
      expect(afterFirstJob?.status).toBe("pendingEmbedding");
      expect(firstChunkStatuses.filter((status) => status === "indexed")).toHaveLength(2);
      expect(firstChunkStatuses.filter((status) => status === "pendingEmbedding")).toHaveLength(1);
      expect(second).toMatchObject({ processed: 1, chunks: 1 });
      expect(committed.committed).toBe(1);
      expect(afterCommitJob?.status).toBe("indexed");
      expect(mutableEmbeddedGroups.map((group) => group.length)).toEqual([2, 1]);
      expect(upserted).toHaveLength(3);
      expect([...fingerprints.data.values()]).toHaveLength(1);
    }),
  );

  it.effect(
    "reconstructs commit messages when an embed message retries after indexing chunks",
    () =>
      Effect.gen(function* () {
        const runs = makeCollection<IndexRun>(indexRuns.name);
        const jobs = makeCollection<IndexJob>(indexJobs.name);
        const chunks = makeCollection<IndexChunk>(indexChunks.name);
        const fingerprints = makeCollection<FingerprintRow>(toolFingerprints.name);
        const blobs = makeBlobs();
        let embedCalls = 0;
        const store: VectorStore = {
          maxTopK: 100,
          query: () => Effect.succeed([]),
          upsert: () => Effect.void,
          deleteByIds: () => Effect.void,
        };
        const embedder: ToolEmbedder = {
          model: "test",
          dimensions: 3,
          embedDocuments: (texts) =>
            Effect.sync(() => {
              embedCalls++;
              return texts.map(() => [0.1, 0.2, 0.3]);
            }),
          embedQuery: () => Effect.succeed([0.1, 0.2, 0.3]),
        };

        const createdAt = new Date(0).toISOString();
        const lexicalTextKey = "test/lexical-retry.txt";
        const job: IndexJob = {
          runId: "run-embed-retry",
          namespace,
          partition: 0,
          ordinal: 0,
          address: "tools.github.repos.get",
          path: "github.repos.get",
          name: "repos.get",
          integration: "github",
          description: "Get a repository",
          status: "pendingEmbedding",
          fingerprint: "fp-embed-retry",
          oldChunkIds: [],
          chunkIds: ["chunk-0"],
          lexicalTextKey,
          createdAt,
          updatedAt: createdAt,
        };
        const chunkRow: IndexChunk = {
          runId: job.runId,
          namespace,
          partition: 0,
          path: job.path,
          chunkId: "chunk-0",
          facet: "description",
          chunkIndex: 0,
          embeddingTextKey: "test/chunk-retry.txt",
          embeddingTextBytes: "chunk retry text".length,
          embeddingTextTokens: 4,
          name: job.name,
          integration: job.integration,
          description: job.description,
          status: "pendingEmbedding",
          createdAt,
          updatedAt: createdAt,
        };
        yield* blobs.put(lexicalTextKey, "github github.repos.get repos.get", { owner });
        yield* blobs.put(chunkRow.embeddingTextKey, "chunk retry text", { owner });
        yield* jobs.put({ owner, key: `${job.runId}:${job.path}`, data: job });
        yield* chunks.put({
          owner,
          key: `${chunkRow.runId}:${chunkRow.path}:${chunkRow.chunkId}`,
          data: chunkRow,
        });

        const base = {
          namespace,
          executor: makeExecutor({ raw: 0, codegen: 0 }),
          runs,
          jobs,
          chunks,
          fingerprints,
          blobs,
          owner,
          embedder,
          store,
          chunker: makeFacetChunker(),
        };
        const first = yield* embed({
          ...base,
          runId: job.runId,
          chunkRefs: [{ path: job.path, chunkId: "chunk-0" }],
        });
        const retry = yield* embed({
          ...base,
          runId: job.runId,
          chunkRefs: [{ path: job.path, chunkId: "chunk-0" }],
        });
        const committed = yield* commit({ ...base, runId: job.runId, paths: [job.path] });

        expect(first).toMatchObject({ processed: 1, chunks: 1, paths: [job.path] });
        expect(retry).toMatchObject({ processed: 0, chunks: 0, paths: [job.path] });
        expect(committed.committed).toBe(1);
        expect(embedCalls).toBe(1);
        expect(jobs.data.get(`${job.runId}:${job.path}`)?.status).toBe("indexed");
      }),
  );

  it.effect("commits zero-chunk embed jobs so fingerprints can warm future runs", () =>
    Effect.gen(function* () {
      const runs = makeCollection<IndexRun>(indexRuns.name);
      const jobs = makeCollection<IndexJob>(indexJobs.name);
      const chunks = makeCollection<IndexChunk>(indexChunks.name);
      const fingerprints = makeCollection<FingerprintRow>(toolFingerprints.name);
      const blobs = makeBlobs();
      const store: VectorStore = {
        maxTopK: 100,
        query: () => Effect.succeed([]),
        upsert: () => Effect.die("zero-chunk jobs must not upsert vectors"),
        deleteByIds: () => Effect.void,
      };
      const embedder: ToolEmbedder = {
        model: "test",
        dimensions: 3,
        embedDocuments: () => Effect.die("zero-chunk jobs must not embed"),
        embedQuery: () => Effect.succeed([0.1, 0.2, 0.3]),
      };

      const createdAt = new Date(0).toISOString();
      const job: IndexJob = {
        runId: "run-zero",
        namespace,
        partition: 0,
        ordinal: 0,
        address: "tools.github.repos.empty",
        path: "github.repos.empty",
        name: "repos.empty",
        integration: "github",
        description: "Empty tool",
        status: "pendingEmbedding",
        fingerprint: "fp-zero",
        oldChunkIds: [],
        chunkIds: [],
        createdAt,
        updatedAt: createdAt,
      };
      yield* jobs.put({ owner, key: `${job.runId}:${job.path}`, data: job });

      const result = yield* commit({
        namespace,
        executor: makeExecutor({ raw: 0, codegen: 0 }),
        runs,
        jobs,
        chunks,
        fingerprints,
        blobs,
        owner,
        embedder,
        store,
        chunker: makeFacetChunker(),
        runId: job.runId,
        paths: [job.path],
      });

      expect(result).toMatchObject({ committed: 1 });
      expect(jobs.data.get(`${job.runId}:${job.path}`)?.status).toBe("indexed");
      expect(fingerprints.data.get(job.path)).toMatchObject({
        path: job.path,
        fingerprint: "fp-zero",
        chunkIds: [],
      });
    }),
  );
});

describe("ToolSearchIndex manifest snapshot", () => {
  const makeTools = (count: number): Tool[] =>
    Array.from({ length: count }, (_, i) => ({
      address: `tools.github.repos.get${i}` as never,
      name: `repos.get${i}` as never,
      integration: "github" as never,
      description: `Get repository ${i}`,
      owner,
      connection: "default" as never,
      pluginId: "test",
    }));

  /** Executor mock that counts `tools.manifest()` calls so a test can prove the
   *  scan reads the KV snapshot rather than re-querying the manifest per page. */
  const makeCountingExecutor = (tools: Tool[]) => {
    const counters = { manifest: 0 };
    const executor: Pick<Executor, "tools" | "cache"> = {
      tools: {
        list: () => Effect.succeed(tools),
        manifest: () => {
          counters.manifest++;
          return Effect.succeed(tools.map((tool) => manifestForTool(tool)));
        },
        schema: () => Effect.succeed(null),
      },
      cache: makeMemoryCache(),
    };
    return { executor: executor as Executor, counters };
  };

  const makeBase = (executor: Executor) => ({
    namespace,
    executor,
    runs: makeCollection<IndexRun>(indexRuns.name),
    jobs: makeCollection<IndexJob>(indexJobs.name),
    chunks: makeCollection<IndexChunk>(indexChunks.name),
    fingerprints: makeCollection<FingerprintRow>(toolFingerprints.name),
    blobs: makeBlobs(),
    owner,
  });

  it.effect("reads the manifest once at create and pages scans from the KV snapshot", () =>
    Effect.gen(function* () {
      const { executor, counters } = makeCountingExecutor(makeTools(5));
      const base = makeBase(executor);

      yield* create({ ...base, runId: "run-snap", partitionCount: 1 });
      expect(counters.manifest).toBe(1);

      let pages = 0;
      let hasMore = true;
      while (hasMore) {
        const result = yield* scan({ ...base, runId: "run-snap", partition: 0, limit: 2 });
        hasMore = result.hasMore;
        pages++;
      }

      expect(pages).toBe(3); // ceil(5 / 2) pages, each from the snapshot
      expect(counters.manifest).toBe(1); // never re-read during scan
      expect(base.jobs.data.size).toBe(5); // every tool scanned exactly once
    }),
  );

  it.effect("fails the scan when the run snapshot is missing (no D1 fallback)", () =>
    Effect.gen(function* () {
      const { executor, counters } = makeCountingExecutor(makeTools(2));
      const base = makeBase(executor);

      // No `create`, so nothing was written to the KV snapshot.
      const error = yield* Effect.flip(
        scan({ ...base, runId: "run-missing", partition: 0, limit: 10 }),
      );

      expect(error).toBeInstanceOf(SemanticSearchError); // KV miss → fail, not a live read
      expect(counters.manifest).toBe(0); // the scan never falls back to a live manifest read
    }),
  );

  it.effect("clears the partition snapshots when the run completes", () =>
    Effect.gen(function* () {
      const { executor } = makeCountingExecutor(makeTools(3));
      const base = makeBase(executor);

      yield* create({ ...base, runId: "run-clear", partitionCount: 1 });
      let hasMore = true;
      while (hasMore) {
        const result = yield* scan({ ...base, runId: "run-clear", partition: 0, limit: 10 });
        hasMore = result.hasMore;
      }

      const store: VectorStore = {
        maxTopK: 100,
        query: () => Effect.succeed([]),
        upsert: () => Effect.void,
        deleteByIds: () => Effect.void,
      };
      const embedder: ToolEmbedder = {
        model: "test",
        dimensions: 3,
        embedDocuments: (texts) => Effect.succeed(texts.map(() => [0.1, 0.2, 0.3])),
        embedQuery: () => Effect.succeed([0.1, 0.2, 0.3]),
      };
      yield* complete({
        ...base,
        store,
        embedder,
        chunker: makeFacetChunker(),
        runId: "run-clear",
      });

      // The snapshot is gone, so a post-completion scan can no longer read it.
      const error = yield* Effect.flip(
        scan({ ...base, runId: "run-clear", partition: 0, limit: 10 }),
      );
      expect(error).toBeInstanceOf(SemanticSearchError); // snapshot cleared on completion
    }),
  );

  it.effect("clears the partition snapshots when the run terminally fails", () =>
    Effect.gen(function* () {
      const { executor } = makeCountingExecutor(makeTools(3));
      const base = makeBase(executor);

      yield* create({ ...base, runId: "run-failclear", partitionCount: 1 });
      const failed = yield* fail({ ...base, runId: "run-failclear", error: "queue exhausted" });
      expect(failed.runFailed).toBe(true); // no pending paths/chunks → run is terminally failed

      const error = yield* Effect.flip(
        scan({ ...base, runId: "run-failclear", partition: 0, limit: 10 }),
      );
      expect(error).toBeInstanceOf(SemanticSearchError); // snapshot cleared on terminal failure
    }),
  );
});
