import { describe, expect, it } from "@effect/vitest";
import type {
  Executor,
  Owner,
  PluginStorageCollectionFacade,
  PluginStorageEntry,
} from "@executor-js/sdk/core";
import { makeInMemoryBlobStore, pluginBlobStore } from "@executor-js/sdk/core";
import { Effect } from "effect";

import { makeFacetChunker } from "./chunker";
import {
  type FingerprintRow,
  type StagedIndexChunk,
  type StagedIndexJob,
  type StagedIndexRun,
  stagedIndexChunks,
  stagedIndexJobs,
  stagedIndexRuns,
  toolFingerprints,
} from "./collections";
import type { ToolEmbedder } from "./embedder";
import {
  diffIndexPartitionPage,
  embedIndexPartitionPage,
  materializeIndexPartitionPage,
  seedIndexPartitionPage,
  startIndexRun,
} from "./indexer";
import type { VectorInput, VectorStore } from "./store";

const owner: Owner = "org" as Owner;
const namespace = "test-ns";

const makeBlobs = () =>
  pluginBlobStore(makeInMemoryBlobStore(), { org: "test-org", user: null }, "semanticSearch");

const makeExecutor = (counters: { raw: number; codegen: number }): Executor => {
  const executor: Pick<Executor, "tools"> = {
    tools: {
      list: () =>
        Effect.succeed([
          {
            address: "tools.github.repos.get" as never,
            name: "repos.get" as never,
            integration: "github" as never,
            description: "Get a repository",
            owner,
            connection: "default" as never,
            pluginId: "test",
          },
        ]),
      schema: (address, options) => {
        const includeTypeScript = options?.includeTypeScript ?? true;
        if (includeTypeScript) counters.codegen++;
        else counters.raw++;
        return Effect.succeed({
          address,
          inputSchema: { type: "object", properties: { owner: { type: "string" } } },
          inputTypeScript: includeTypeScript ? "{ owner: string }" : undefined,
        });
      },
    },
  };
  return executor as Executor;
};

type TestCollection<T extends object> = PluginStorageCollectionFacade<any> & {
  readonly data: Map<string, T>;
};

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
    return Object.entries(where).every(
      ([key, expected]) => (value as Record<string, unknown>)[key] === expected,
    );
  };
  const facade = {
    data,
    get: ({ key }: { key: string }) =>
      Effect.succeed(data.has(key) ? entry(key, data.get(key)!) : null),
    getForOwner: ({ key }: { key: string }) =>
      Effect.succeed(data.has(key) ? entry(key, data.get(key)!) : null),
    list: () => Effect.succeed([...data.entries()].map(([key, value]) => entry(key, value))),
    put: ({ key, data: value }: { key: string; data: T }) =>
      Effect.sync(() => {
        data.set(key, value);
        return entry(key, value);
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
      groupCount: () => Effect.succeed([]),
      timeBuckets: () => Effect.succeed([]),
      stats: () => Effect.succeed({ count: 0, min: null, max: null, percentiles: [] }),
    },
    remove: ({ key }: { key: string }) => Effect.sync(() => data.delete(key)),
  };
  // oxlint-disable-next-line executor/no-double-cast -- test fixture implements the storage facade methods exercised by these indexer tests
  return facade as unknown as TestCollection<T>;
};

describe("staged indexer", () => {
  it.effect("diffs, materializes, embeds, and commits changed tools by staged phase", () =>
    Effect.gen(function* () {
      const counters = { raw: 0, codegen: 0 };
      const executor = makeExecutor(counters);
      const runs = makeCollection<StagedIndexRun>(stagedIndexRuns.name);
      const jobs = makeCollection<StagedIndexJob>(stagedIndexJobs.name);
      const chunks = makeCollection<StagedIndexChunk>(stagedIndexChunks.name);
      const fingerprints = makeCollection<FingerprintRow>(toolFingerprints.name);
      const blobs = makeBlobs();
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
        embedDocuments: (texts) => Effect.succeed(texts.map(() => [0.1, 0.2, 0.3])),
        embedQuery: () => Effect.succeed([0.1, 0.2, 0.3]),
      };

      const base = { namespace, executor, runs, jobs, chunks, fingerprints, blobs, owner };
      yield* startIndexRun({ ...base, runId: "run-1", partitionCount: 1 });
      const seeded = yield* seedIndexPartitionPage({
        ...base,
        runId: "run-1",
        partition: 0,
        limit: 10,
      });
      const diff = yield* diffIndexPartitionPage({
        ...base,
        runId: "run-1",
        partition: 0,
        limit: 10,
      });
      const materialized = yield* materializeIndexPartitionPage({
        ...base,
        embedder,
        store,
        chunker: makeFacetChunker(),
        runId: "run-1",
        partition: 0,
        limit: 10,
      });
      const embedded = yield* embedIndexPartitionPage({
        ...base,
        embedder,
        store,
        chunker: makeFacetChunker(),
        runId: "run-1",
        partition: 0,
        limit: 10,
      });

      expect(seeded).toMatchObject({ processed: 1 });
      expect(diff).toMatchObject({ processed: 1, changed: 1, unchanged: 0 });
      expect(materialized.processed).toBe(1);
      expect(materialized.chunks).toBeGreaterThan(0);
      expect(embedded).toMatchObject({ processed: 1, chunks: materialized.chunks });
      expect(counters).toEqual({ raw: 1, codegen: 1 });
      expect(upserted).toHaveLength(materialized.chunks);
      expect([...fingerprints.data.values()]).toHaveLength(1);
      expect([...jobs.data.values()][0]?.status).toBe("committed");
    }),
  );

  it.effect("embeds only the chunks that fit the page budget and commits the job later", () =>
    Effect.gen(function* () {
      const runs = makeCollection<StagedIndexRun>(stagedIndexRuns.name);
      const jobs = makeCollection<StagedIndexJob>(stagedIndexJobs.name);
      const chunks = makeCollection<StagedIndexChunk>(stagedIndexChunks.name);
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
      const job: StagedIndexJob = {
        runId: "run-budget",
        namespace,
        partition: 0,
        ordinal: 0,
        address: "tools.github.repos.get",
        path: "github.repos.get",
        name: "repos.get",
        integration: "github",
        description: "Get a repository",
        status: "pendingEmbed",
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
            const chunk: StagedIndexChunk = {
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
              status: "pendingEmbed",
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

      const first = yield* embedIndexPartitionPage({
        ...base,
        runId: job.runId,
        partition: 0,
        limit: 10,
        maxChunks: 2,
      });
      const afterFirstJob = jobs.data.get(`${job.runId}:${job.path}`);
      const firstChunkStatuses = [...chunks.data.values()].map((chunk) => chunk.status);

      const second = yield* embedIndexPartitionPage({
        ...base,
        runId: job.runId,
        partition: 0,
        limit: 10,
        maxChunks: 10,
      });
      const afterSecondJob = jobs.data.get(`${job.runId}:${job.path}`);

      expect(first).toMatchObject({ processed: 1, chunks: 2 });
      expect(afterFirstJob?.status).toBe("pendingEmbed");
      expect(firstChunkStatuses.filter((status) => status === "committed")).toHaveLength(2);
      expect(firstChunkStatuses.filter((status) => status === "pendingEmbed")).toHaveLength(1);
      expect(second).toMatchObject({ processed: 1, chunks: 1 });
      expect(afterSecondJob?.status).toBe("committed");
      expect(mutableEmbeddedGroups.map((group) => group.length)).toEqual([2, 1]);
      expect(upserted).toHaveLength(3);
      expect([...fingerprints.data.values()]).toHaveLength(1);
    }),
  );
});
