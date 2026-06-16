import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embed, embedMany } from "ai";
import { Effect } from "effect";

import { SemanticSearchError } from "./errors";

/** Turns tool documents and queries into embedding vectors. Document and query
 *  embeddings use different task types (Gemini distinguishes
 *  `RETRIEVAL_DOCUMENT` from `RETRIEVAL_QUERY`), so the two methods are
 *  separate. The plugin treats this as a seam: tests inject a deterministic
 *  embedder, production uses {@link makeGeminiEmbedder}. */
export interface ToolEmbedder {
  readonly model: string;
  readonly dimensions: number;
  readonly embedDocuments: (
    texts: readonly string[],
  ) => Effect.Effect<readonly (readonly number[])[], SemanticSearchError>;
  readonly embedQuery: (text: string) => Effect.Effect<readonly number[], SemanticSearchError>;
}

export interface GeminiEmbedderOptions {
  readonly apiKey: string;
  /** Gemini embedding model id. Defaults to the v2 model. */
  readonly model?: string;
  /** Output dimensionality (MRL truncation). MUST match the Vectorize index. */
  readonly dimensions?: number;
  readonly batchSize?: number;
}

/** Gemini Embedding 2: natively multimodal, default 3072d, MRL-truncatable to
 *  1536/768. We default to 1536d as a quality/size balance for a tool catalog. */
export const DEFAULT_GEMINI_MODEL = "gemini-embedding-2";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_BATCH_SIZE = 32;
const DOCUMENT_TASK_TYPE = "RETRIEVAL_DOCUMENT";
const QUERY_TASK_TYPE = "RETRIEVAL_QUERY";

const chunk = <A>(items: readonly A[], size: number): readonly (readonly A[])[] => {
  const safe = Math.max(1, Math.floor(size));
  const out: A[][] = [];
  for (let i = 0; i < items.length; i += safe) {
    out.push(items.slice(i, i + safe));
  }
  return out;
};

export const makeGeminiEmbedder = (options: GeminiEmbedderOptions): ToolEmbedder => {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const google = createGoogleGenerativeAI({ apiKey: options.apiKey });

  const embedTexts = (
    texts: readonly string[],
    taskType: typeof DOCUMENT_TASK_TYPE | typeof QUERY_TASK_TYPE,
  ): Effect.Effect<readonly (readonly number[])[], SemanticSearchError> =>
    Effect.tryPromise({
      try: async () => {
        if (texts.length === 0) return [];
        const textModel = google.textEmbedding(model);
        const providerOptions = { google: { outputDimensionality: dimensions, taskType } };
        if (texts.length === 1) {
          const { embedding } = await embed({
            model: textModel,
            value: texts[0]!,
            providerOptions,
          });
          return [embedding];
        }
        const { embeddings } = await embedMany({
          model: textModel,
          values: [...texts],
          maxParallelCalls: 5,
          providerOptions,
        });
        return embeddings;
      },
      catch: (cause) =>
        new SemanticSearchError({ message: `Gemini embedding failed for ${model}.`, cause }),
    });

  return {
    model,
    dimensions,
    embedDocuments: (texts) =>
      Effect.forEach(chunk(texts, batchSize), (group) => embedTexts(group, DOCUMENT_TASK_TYPE), {
        concurrency: 1,
      }).pipe(Effect.map((groups) => groups.flat())),
    embedQuery: (text) =>
      embedTexts([text], QUERY_TASK_TYPE).pipe(Effect.map((vectors) => vectors[0] ?? [])),
  };
};
