export type { Embedder, EmbedderConfig, EmbedHint } from "./types"
export { l2Normalize } from "./normalize"

import type { Embedder, EmbedderConfig } from "./types"

/**
 * Create an embedder from configuration.
 * Dispatches to the appropriate provider implementation and fails on
 * unsupported or misconfigured providers.
 */
export async function createEmbedder(
  config: EmbedderConfig,
): Promise<Embedder> {
  switch (config.provider) {
    case "local": {
      // Dynamic import to avoid loading node-llama-cpp unless needed
      const { createLocalEmbedder } = await import("./providers/local")
      return createLocalEmbedder(config)
    }
    default: {
      // Shipped AI SDK remote providers (google, openai)
      const { createAiSdkEmbedder } = await import("./providers/ai-sdk")
      return createAiSdkEmbedder(config)
    }
  }
}
