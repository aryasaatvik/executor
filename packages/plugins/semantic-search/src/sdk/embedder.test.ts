import { describe, expect, it } from "@effect/vitest";
import type { EmbeddingModel } from "ai";
import { Effect, Exit } from "effect";

import { makeEmbedder } from "./embedder";

const makeModel = (embed: (values: string[]) => number[][], calls: unknown[]): EmbeddingModel => ({
  specificationVersion: "v3",
  provider: "test",
  modelId: "test-embedding",
  maxEmbeddingsPerCall: undefined,
  supportsParallelCalls: true,
  doEmbed: async ({ values, providerOptions }) => {
    calls.push({ values, providerOptions });
    return {
      embeddings: embed(values),
      usage: { tokens: values.length },
      warnings: [],
    };
  },
});

describe("makeEmbedder", () => {
  it.effect("embeds documents and queries through the supplied AI SDK model", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const embedder = makeEmbedder({
        model: makeModel((values) => values.map((value, index) => [value.length, index]), calls),
        modelId: "test-embedding",
        dimensions: 2,
        batchSize: 2,
        documentProviderOptions: { test: { task: "document" } },
        queryProviderOptions: { test: { task: "query" } },
      });

      const docs = yield* embedder.embedDocuments(["alpha", "beta", "gamma"]);
      const query = yield* embedder.embedQuery("alpha");

      expect(docs).toEqual([
        [5, 0],
        [4, 1],
        [5, 0],
      ]);
      expect(query).toEqual([5, 0]);
      expect(calls).toEqual([
        {
          values: ["alpha", "beta"],
          providerOptions: { test: { task: "document" } },
        },
        {
          values: ["gamma"],
          providerOptions: { test: { task: "document" } },
        },
        {
          values: ["alpha"],
          providerOptions: { test: { task: "query" } },
        },
      ]);
    }),
  );

  it.effect("rejects vectors whose dimensions do not match the embedder", () =>
    Effect.gen(function* () {
      const embedder = makeEmbedder({
        model: makeModel(() => [[1, 2, 3]], []),
        modelId: "test-embedding",
        dimensions: 2,
      });

      const exit = yield* Effect.exit(embedder.embedDocuments(["alpha"]));

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
