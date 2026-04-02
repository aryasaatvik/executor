import {
  google,
} from "@ai-sdk/google";
import {
  embedMany as generateEmbeddings,
} from "ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  SearchEmbedderService,
  type SearchEmbedder,
  type SearchEmbedderInput,
  embeddingTextFromInput,
} from "./embedder";
import {
  makeSqliteSearchEmbedderSignature,
} from "./shared";

const GOOGLE_EMBEDDING_MODEL = "gemini-embedding-2-preview";
const GOOGLE_EMBEDDING_BATCH_SIZE = 50;

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const batchValues = <T>(values: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }

  return batches;
};

export const GoogleEmbedderLayer = (input: {
  dimensions: 2048 | 3072;
}) =>
  Layer.effect(
    SearchEmbedderService,
    Effect.gen(function* () {
      const apiKey = process.env.GOOGLE_API_KEY?.trim();
      if (!apiKey) {
        return yield* Effect.fail(
          new Error(
            "GOOGLE_API_KEY is required when sqlite search embedder kind=google",
          ),
        );
      }

      const key = "google";
      const model = google.embeddingModel(GOOGLE_EMBEDDING_MODEL);
      const service: SearchEmbedder = {
        key,
        dimensions: input.dimensions,
        signature: makeSqliteSearchEmbedderSignature({
          key,
          dimensions: input.dimensions,
        }),
        embed: async (embedInput) => {
          const [embedding] = await service.embedMany([embedInput]);
          if (!embedding) {
            throw new Error("google embedder returned no embedding");
          }
          return embedding;
        },
        embedMany: async (embedInputs) => {
          try {
            const embeddings: Float32Array[] = [];

            for (const batch of batchValues(embedInputs, GOOGLE_EMBEDDING_BATCH_SIZE)) {
              const { embeddings: batchEmbeddings } = await generateEmbeddings({
                model,
                values: batch.map(embeddingTextFromInput),
                providerOptions: {
                  google: {
                    outputDimensionality: input.dimensions,
                  },
                },
              });

              embeddings.push(
                ...batchEmbeddings.map((embedding) => Float32Array.from(embedding)),
              );
            }

            return embeddings;
          } catch (cause) {
            throw toError(cause);
          }
        },
      };

      return service;
    }),
  );
