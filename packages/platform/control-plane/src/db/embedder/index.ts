export type { Embedder, EmbedderConfig, EmbedHint } from "./types"
export { l2Normalize } from "./normalize"

import type { Embedder, EmbedderConfig } from "./types"

/**
 * Create an embedder from configuration.
 * Dispatches to the appropriate provider implementation.
 *
 * Returns null if the config is invalid or the provider can't be loaded.
 */
export async function createEmbedder(
  config: EmbedderConfig,
): Promise<Embedder | null> {
  switch (config.provider) {
    case "local": {
      // Dynamic import to avoid loading node-llama-cpp unless needed
      const { createLocalEmbedder } = await import("./providers/local")
      return createLocalEmbedder(config)
    }
    default: {
      // AI SDK providers (google, openai, cohere, etc.)
      const { createAiSdkEmbedder } = await import("./providers/ai-sdk")
      return createAiSdkEmbedder(config)
    }
  }
}
