import { Effect } from "effect";

import type { ToolEmbedder } from "./embedder";
import { SemanticSearchError } from "./errors";

// ---------------------------------------------------------------------------
// OpenAI-compatible embedder — POSTs to `${baseUrl}/embeddings` in the standard
// OpenAI shape, so any endpoint that speaks that protocol works (a local model
// server for cheap experimentation, OpenAI, vLLM, TEI, llama.cpp, Ollama's
// `/v1`, etc.). Provided as a layer behind `EmbedderService`, it's a drop-in
// swap for the Gemini embedder.
// ---------------------------------------------------------------------------

export interface OpenAiCompatibleEmbedderOptions {
  /** Base URL up to (not including) `/embeddings`, e.g. `http://localhost:1234/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
  /** Optional bearer token; local servers usually need none. */
  readonly apiKey?: string;
  /** Inputs per request. */
  readonly batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 64;

interface OpenAiEmbeddingsResponse {
  readonly data?: readonly { readonly embedding?: readonly number[] }[];
}

const chunk = <A>(items: readonly A[], size: number): readonly (readonly A[])[] => {
  const safe = Math.max(1, Math.floor(size));
  const out: A[][] = [];
  for (let i = 0; i < items.length; i += safe) out.push(items.slice(i, i + safe));
  return out;
};

export const makeOpenAiCompatibleEmbedder = (
  options: OpenAiCompatibleEmbedderOptions,
): ToolEmbedder => {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/embeddings`;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const embedBatch = (
    texts: readonly string[],
  ): Effect.Effect<readonly (readonly number[])[], SemanticSearchError> => {
    if (texts.length === 0) return Effect.succeed([]);
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            },
            // `dimensions` is honored by OpenAI + most compatible servers; ignored otherwise.
            body: JSON.stringify({
              model: options.model,
              input: [...texts],
              dimensions: options.dimensions,
            }),
          }),
        catch: (cause) =>
          new SemanticSearchError({
            message: `OpenAI-compatible embedding failed for ${options.model} at ${endpoint}.`,
            cause,
          }),
      });
      if (!response.ok) {
        // Read the error body for a better message; tolerate a read failure by
        // falling back to "". `Effect.catch(fn)` is the catch-all in this Effect
        // version (4.0.0-beta) — `Effect.catchAll` does not exist on `Effect`.
        const body = yield* Effect.tryPromise(() => response.text()).pipe(
          Effect.catch(() => Effect.succeed("")),
        );
        return yield* new SemanticSearchError({
          message: `embeddings HTTP ${response.status}: ${body.slice(0, 300)}`,
        });
      }
      const json = yield* Effect.tryPromise({
        try: () => response.json() as Promise<OpenAiEmbeddingsResponse>,
        catch: (cause) =>
          new SemanticSearchError({
            message: `OpenAI-compatible embedding failed for ${options.model} at ${endpoint}.`,
            cause,
          }),
      });
      const embeddings = json.data?.map((item) => item.embedding ?? []);
      if (!embeddings || embeddings.length !== texts.length) {
        return yield* new SemanticSearchError({
          message: `embeddings response returned ${embeddings?.length ?? 0} vectors for ${texts.length} inputs`,
        });
      }
      return embeddings;
    });
  };

  return {
    model: options.model,
    dimensions: options.dimensions,
    embedDocuments: (texts) =>
      Effect.forEach(chunk(texts, batchSize), (group) => embedBatch(group), {
        concurrency: 1,
      }).pipe(Effect.map((groups) => groups.flat())),
    embedQuery: (text) => embedBatch([text]).pipe(Effect.map((vectors) => vectors[0] ?? [])),
  };
};
