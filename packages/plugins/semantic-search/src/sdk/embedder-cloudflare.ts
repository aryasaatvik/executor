import type {
  Ai,
  Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input,
  Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output,
} from "@cloudflare/workers-types";
import { Effect } from "effect";

import type { ToolEmbedder } from "./embedder";
import { SemanticSearchError } from "./errors";

export const DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_DIMENSIONS = 1024;

export interface CloudflareWorkersAiEmbedderOptions {
  readonly ai: Pick<
    Ai<{
      readonly "@cf/qwen/qwen3-embedding-0.6b": {
        readonly inputs: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input;
        readonly postProcessedOutputs: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output;
      };
    }>,
    "run"
  >;
  readonly dimensions?: number;
  readonly batchSize?: number;
  readonly documentInstruction?: string;
  readonly queryInstruction?: string;
}

const DEFAULT_BATCH_SIZE = 32;

const chunk = <A>(items: readonly A[], size: number): A[][] => {
  const safe = Math.max(1, Math.floor(size));
  const out: A[][] = [];
  for (let i = 0; i < items.length; i += safe) out.push(items.slice(i, i + safe));
  return out;
};

const normalizeVectors = (
  response: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output,
  count: number,
): readonly (readonly number[])[] | undefined => {
  if (response.data?.length === count) return response.data;
  return undefined;
};

export const makeCloudflareWorkersAiEmbedder = (
  options: CloudflareWorkersAiEmbedderOptions,
): ToolEmbedder => {
  const model = DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const embedBatch = (
    kind: "documents" | "queries",
    texts: readonly string[],
    instruction: string | undefined,
  ): Effect.Effect<readonly (readonly number[])[], SemanticSearchError> => {
    if (texts.length === 0) return Effect.succeed([]);
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          options.ai.run(model, {
            [kind]: [...texts],
            ...(instruction ? { instruction } : {}),
          } satisfies Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input),
        catch: (cause) =>
          new SemanticSearchError({
            message: `Cloudflare Workers AI embedding failed for ${model}.`,
            cause,
          }),
      });
      const embeddings = normalizeVectors(response, texts.length);
      if (!embeddings) {
        return yield* new SemanticSearchError({
          message: `Cloudflare Workers AI returned ${response.data?.length ?? 0} vectors for ${texts.length} inputs.`,
        });
      }
      return embeddings;
    });
  };

  return {
    model,
    dimensions: options.dimensions ?? DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_DIMENSIONS,
    embedDocuments: (texts) =>
      Effect.forEach(
        chunk(texts, batchSize),
        (group) => embedBatch("documents", group, options.documentInstruction),
        { concurrency: 1 },
      ).pipe(Effect.map((groups) => groups.flat())),
    embedQuery: (text) =>
      embedBatch("queries", [text], options.queryInstruction).pipe(
        Effect.map((vectors) => vectors[0] ?? []),
      ),
  };
};
