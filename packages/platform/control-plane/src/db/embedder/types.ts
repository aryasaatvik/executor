/**
 * Hint for the embedding task type.
 * - "document": embedding text for indexing/storage (tools being indexed)
 * - "query": embedding text for search/retrieval (user search queries)
 */
export type EmbedHint = "document" | "query"

/**
 * Core embedder interface. Implementations provide text → vector conversion.
 */
export interface Embedder {
  /** Embed a single text string. */
  embed(text: string, hint?: EmbedHint): Promise<number[]>

  /** Embed multiple texts in a batch. More efficient than calling embed() in a loop. */
  embedBatch(texts: string[], hint?: EmbedHint): Promise<number[][]>

  /** The number of dimensions in the output vectors. */
  readonly dimensions: number

  /** Provider identifier (e.g., "local", "google", "openai"). */
  readonly provider: string

  /** Model identifier (e.g., "gemini-embedding-2-preview", "Qwen3-Embedding-0.6B-Q8_0"). */
  readonly model: string
}

/**
 * Configuration for an embedding provider.
 */
export interface EmbedderConfig {
  /** Provider type: "local" or one of the shipped remote providers. */
  provider:
    | "local"
    | "google"
    | "openai"
    | (string & {})

  /** Model identifier. Optional — each provider has a default. */
  model?: string

  /** API key for cloud providers. Supports ${ENV_VAR} substitution. */
  apiKey?: string

  /** Output dimensions. Optional — uses provider/model default. For Google MRL truncation. */
  dimensions?: number
}
