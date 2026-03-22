import type { Embedder, EmbedderConfig, EmbedHint } from "../types"
import { l2Normalize } from "../normalize"

const PROVIDER_PACKAGES: Record<string, string> = {
  google: "@ai-sdk/google",
  openai: "@ai-sdk/openai",
}

const DEFAULT_MODELS: Record<string, string> = {
  google: "gemini-embedding-2-preview",
  openai: "text-embedding-3-small",
}

const DEFAULT_DIMENSIONS: Record<string, number> = {
  google: 3072,
  openai: 1536,
}

const PROVIDER_HINTS: Record<string, { document?: object; query?: object }> = {
  google: {
    document: { taskType: "RETRIEVAL_DOCUMENT" },
    query: { taskType: "RETRIEVAL_QUERY" },
  },
}

/**
 * Get provider-specific hint metadata for the given embed hint.
 */
function getProviderHints(
  providerName: string,
  hint?: EmbedHint,
): object | undefined {
  if (!hint) return undefined
  const hints = PROVIDER_HINTS[providerName]
  if (!hints) return undefined
  return hints[hint]
}

/**
 * Dynamically load a provider package.
 *
 * The runtime must not mutate the checkout or install dependencies.
 * Missing provider packages should fail deterministically.
 */
async function importProviderPackage(
  providerName: string,
): Promise<Record<string, unknown>> {
  const packageName = PROVIDER_PACKAGES[providerName]
  if (!packageName) {
    throw new Error(
      `Unknown AI SDK provider "${providerName}". ` +
        `Known providers: ${Object.keys(PROVIDER_PACKAGES).join(", ")}`,
    )
  }

  try {
    return await import(packageName)
  } catch (error) {
    throw new Error(
      `Failed to load provider package ${packageName}. ` +
        `Install it before enabling ${providerName} semantic search. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Load and configure the embedding model from the AI SDK provider.
 */
async function loadEmbeddingModel(
  providerName: string,
  model: string,
  apiKey: string | undefined,
  dimensions: number | undefined,
) {
  const providerModule = await importProviderPackage(providerName)

  // AI SDK provider packages export a factory function named after the provider,
  // e.g. @ai-sdk/google exports `google`, @ai-sdk/openai exports `openai`
  const createProvider = providerModule[providerName] as
    | ((opts?: Record<string, unknown>) => Record<string, unknown>)
    | undefined

  if (typeof createProvider !== "function") {
    throw new Error(
      `Provider package ${PROVIDER_PACKAGES[providerName]} does not export a "${providerName}" function`,
    )
  }

  const providerOpts: Record<string, unknown> = {}
  if (apiKey) {
    providerOpts.apiKey = apiKey
  }

  const provider = createProvider(providerOpts)

  // Get the textEmbeddingModel method
  const textEmbeddingModel = provider.textEmbeddingModel as
    | ((
        modelId: string,
        settings?: Record<string, unknown>,
      ) => unknown
      )
    | undefined

  if (typeof textEmbeddingModel !== "function") {
    // Some providers use .embedding() instead
    const embeddingFn = provider.embedding as
      | ((modelId: string, settings?: Record<string, unknown>) => unknown)
      | undefined

    if (typeof embeddingFn !== "function") {
      throw new Error(
        `Provider "${providerName}" does not have a textEmbeddingModel or embedding method`,
      )
    }

    return embeddingFn(model, buildModelSettings(providerName, dimensions))
  }

  return textEmbeddingModel(model, buildModelSettings(providerName, dimensions))
}

/**
 * Build provider-specific model settings (e.g., dimensions).
 */
function buildModelSettings(
  providerName: string,
  dimensions: number | undefined,
): Record<string, unknown> | undefined {
  if (providerName === "google" && dimensions !== undefined) {
    return { outputDimensionality: dimensions }
  }

  if (
    providerName === "openai" &&
    dimensions !== undefined
  ) {
    return { dimensions }
  }

  return undefined
}

/**
 * Create an embedder using Vercel AI SDK.
 * Supports the remote providers shipped in this branch: Google and OpenAI.
 *
 * Default for Google: gemini-embedding-2-preview, 3072 dims.
 */
export async function createAiSdkEmbedder(
  config: EmbedderConfig,
): Promise<Embedder> {
  const { embed, embedMany } = await import("ai")

  const providerName = config.provider
  const model = config.model ?? DEFAULT_MODELS[providerName] ?? providerName
  const requestedDimensions = config.dimensions
  const dimensions = requestedDimensions ?? DEFAULT_DIMENSIONS[providerName] ?? 3072

  const apiKey = config.apiKey?.trim()
  if (!apiKey) {
    throw new Error(
      `Semantic search provider "${providerName}" requires a resolved api key.`,
    )
  }

  const embeddingModel = await loadEmbeddingModel(
    providerName,
    model,
    apiKey,
    requestedDimensions,
  )

  // Determine if normalization is needed (Google MRL truncation requires L2 normalization)
  const needsNormalization =
    providerName === "google" &&
    requestedDimensions !== undefined &&
    requestedDimensions < 3072

  return {
    provider: providerName,
    model,
    dimensions: dimensions ?? 3072,

    async embed(text: string, hint?: EmbedHint): Promise<number[]> {
      const providerHints = getProviderHints(providerName, hint)
      const { embedding } = await embed({
        model: embeddingModel as Parameters<typeof embed>[0]["model"],
        value: text,
        ...(providerHints
          ? {
              experimental_providerMetadata: {
                [providerName]: providerHints,
              },
            }
          : {}),
      })
      return needsNormalization
        ? l2Normalize([...embedding])
        : [...embedding]
    },

    async embedBatch(
      texts: string[],
      hint?: EmbedHint,
    ): Promise<number[][]> {
      const providerHints = getProviderHints(providerName, hint)
      const { embeddings } = await embedMany({
        model: embeddingModel as Parameters<typeof embedMany>[0]["model"],
        values: texts,
        ...(providerHints
          ? {
              experimental_providerMetadata: {
                [providerName]: providerHints,
              },
            }
          : {}),
      })
      if (needsNormalization) {
        return embeddings.map((e) => l2Normalize([...e]))
      }
      return embeddings.map((e) => [...e])
    },
  }
}
