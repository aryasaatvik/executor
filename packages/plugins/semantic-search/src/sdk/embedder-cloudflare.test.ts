import { describe, expect, it } from "@effect/vitest";
import type {
  Ai,
  Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input,
  Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output,
} from "@cloudflare/workers-types";
import { Effect, Exit } from "effect";

import {
  DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_DIMENSIONS,
  DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL,
  makeCloudflareWorkersAiEmbedder,
} from "./embedder-cloudflare";

describe("makeCloudflareWorkersAiEmbedder", () => {
  it.effect("embeds documents and queries with the qwen model by default", () =>
    Effect.gen(function* () {
      const mutableCalls: unknown[] = [];
      const ai = {
        run: (async (
          model: typeof DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL,
          input: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input,
        ): Promise<Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output> => {
          mutableCalls.push({ model, input });
          const values = input.documents ?? input.queries ?? input.text ?? [];
          const count = Array.isArray(values) ? values.length : 1;
          return {
            data: Array.from({ length: count }, (_, index) => [index + 1, index + 2]),
            shape: [count, 2],
          };
        }) as Ai<{
          readonly "@cf/qwen/qwen3-embedding-0.6b": {
            readonly inputs: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input;
            readonly postProcessedOutputs: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output;
          };
        }>["run"],
      } satisfies Pick<
        Ai<{
          readonly "@cf/qwen/qwen3-embedding-0.6b": {
            readonly inputs: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input;
            readonly postProcessedOutputs: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output;
          };
        }>,
        "run"
      >;
      const embedder = makeCloudflareWorkersAiEmbedder({ ai, dimensions: 2 });

      const docs = yield* embedder.embedDocuments(["alpha", "beta"]);
      const query = yield* embedder.embedQuery("alpha");

      expect(embedder.model).toBe(DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL);
      expect(embedder.dimensions).toBe(2);
      expect(docs).toEqual([
        [1, 2],
        [2, 3],
      ]);
      expect(query).toEqual([1, 2]);
      expect(mutableCalls).toEqual([
        {
          model: DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL,
          input: { documents: ["alpha", "beta"] },
        },
        {
          model: DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL,
          input: { queries: ["alpha"] },
        },
      ]);
      expect(DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_DIMENSIONS).toBe(1024);
    }),
  );

  it.effect("rejects vectors whose dimensions do not match the embedder", () =>
    Effect.gen(function* () {
      const ai = {
        run: (async (
          _model: typeof DEFAULT_CLOUDFLARE_WORKERS_AI_EMBEDDING_MODEL,
          _input: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input,
        ): Promise<Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output> => ({
          data: [[1, 2, 3]],
          shape: [1, 3],
        })) as Ai<{
          readonly "@cf/qwen/qwen3-embedding-0.6b": {
            readonly inputs: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input;
            readonly postProcessedOutputs: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output;
          };
        }>["run"],
      } satisfies Pick<
        Ai<{
          readonly "@cf/qwen/qwen3-embedding-0.6b": {
            readonly inputs: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Input;
            readonly postProcessedOutputs: Ai_Cf_Qwen_Qwen3_Embedding_0_6B_Output;
          };
        }>,
        "run"
      >;
      const embedder = makeCloudflareWorkersAiEmbedder({ ai, dimensions: 2 });

      const exit = yield* Effect.exit(embedder.embedDocuments(["alpha"]));

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
