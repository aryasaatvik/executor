import { embed, embedMany, type EmbeddingModel } from "ai";
import { Effect } from "effect";

import { SemanticSearchError } from "./errors";

type EmbeddingProviderOptions = Parameters<typeof embed>[0]["providerOptions"];

export interface ToolEmbedder {
  readonly model: string;
  readonly dimensions: number;
  readonly embedDocuments: (
    texts: readonly string[],
  ) => Effect.Effect<readonly (readonly number[])[], SemanticSearchError>;
  readonly embedQuery: (text: string) => Effect.Effect<readonly number[], SemanticSearchError>;
}

export interface MakeEmbedderOptions {
  readonly model: EmbeddingModel;
  readonly modelId: string;
  readonly dimensions: number;
  readonly batchSize?: number;
  readonly maxParallelCalls?: number;
  readonly documentProviderOptions?: EmbeddingProviderOptions;
  readonly queryProviderOptions?: EmbeddingProviderOptions;
}

const DEFAULT_BATCH_SIZE = 32;

const chunk = <A>(items: readonly A[], size: number): A[][] => {
  const safe = Math.max(1, Math.floor(size));
  const out: A[][] = [];
  for (let i = 0; i < items.length; i += safe) {
    out.push(items.slice(i, i + safe));
  }
  return out;
};

const validateEmbeddings = (
  embeddings: readonly (readonly number[])[],
  expectedCount: number,
  dimensions: number,
  modelId: string,
): Effect.Effect<readonly (readonly number[])[], SemanticSearchError> => {
  if (
    embeddings.length !== expectedCount ||
    !embeddings.every((vector) => vector.length === dimensions)
  ) {
    return Effect.fail(
      new SemanticSearchError({
        message: `${modelId} returned ${embeddings.length} vectors with invalid dimensions.`,
      }),
    );
  }
  return Effect.succeed(embeddings);
};

export const makeEmbedder = (options: MakeEmbedderOptions): ToolEmbedder => {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxParallelCalls = options.maxParallelCalls ?? 1;

  const embedTexts = (
    texts: readonly string[],
    providerOptions: EmbeddingProviderOptions,
  ): Effect.Effect<readonly (readonly number[])[], SemanticSearchError> =>
    Effect.gen(function* () {
      if (texts.length === 0) return [];
      const embeddings = yield* Effect.tryPromise({
        try: async () => {
          if (texts.length === 1) {
            const { embedding } = await embed({
              model: options.model,
              value: texts[0]!,
              providerOptions,
            });
            return [embedding];
          }
          const { embeddings } = await embedMany({
            model: options.model,
            values: [...texts],
            maxParallelCalls,
            providerOptions,
          });
          return embeddings;
        },
        catch: (cause) =>
          new SemanticSearchError({
            message: `Embedding failed for ${options.modelId}.`,
            cause,
          }),
      });
      return yield* validateEmbeddings(
        embeddings,
        texts.length,
        options.dimensions,
        options.modelId,
      );
    });

  return {
    model: options.modelId,
    dimensions: options.dimensions,
    embedDocuments: (texts) =>
      Effect.forEach(
        chunk(texts, batchSize),
        (group) => embedTexts(group, options.documentProviderOptions),
        { concurrency: 1 },
      ).pipe(Effect.map((groups) => groups.flat())),
    embedQuery: (text) =>
      embedTexts([text], options.queryProviderOptions).pipe(
        Effect.map((vectors) => vectors[0] ?? []),
      ),
  };
};
