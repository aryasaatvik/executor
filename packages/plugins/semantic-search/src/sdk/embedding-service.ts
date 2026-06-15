import { Context, Layer } from "effect";

import { makeHashEmbedder } from "./embedder-hash";
import {
  makeOpenAiCompatibleEmbedder,
  type OpenAiCompatibleEmbedderOptions,
} from "./embedder-openai";
import { makeGeminiEmbedder, type GeminiEmbedderOptions, type ToolEmbedder } from "./embedder";

// ---------------------------------------------------------------------------
// Pluggable embedder seam. The indexer + query provider depend on
// `EmbedderService`; the host (or the eval) supplies ONE of the layers below —
// a local OpenAI-compatible endpoint for cheap experimentation, Gemini for
// production, or the deterministic hash embedder for key-free CI.
// ---------------------------------------------------------------------------

export class EmbedderService extends Context.Service<EmbedderService, ToolEmbedder>()(
  "@executor-js/plugin-semantic-search/EmbedderService",
) {}

export const geminiEmbedderLayer = (options: GeminiEmbedderOptions): Layer.Layer<EmbedderService> =>
  Layer.succeed(EmbedderService)(makeGeminiEmbedder(options));

export const openAiCompatibleEmbedderLayer = (
  options: OpenAiCompatibleEmbedderOptions,
): Layer.Layer<EmbedderService> =>
  Layer.succeed(EmbedderService)(makeOpenAiCompatibleEmbedder(options));

export const hashEmbedderLayer = (dimensions?: number): Layer.Layer<EmbedderService> =>
  Layer.succeed(EmbedderService)(makeHashEmbedder(dimensions));
