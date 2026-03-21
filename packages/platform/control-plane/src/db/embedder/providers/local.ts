import type { Embedder, EmbedderConfig, EmbedHint } from "../types"

const DEFAULT_MODEL = "Qwen3-Embedding-0.6B-Q8_0"
const DEFAULT_MODEL_URI =
  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
const DEFAULT_DIMENSIONS = 1024
const MODEL_CACHE_DIR = "~/.executor/models"

/**
 * Format text for embedding based on the hint.
 * Qwen3-Embedding uses an instruct prefix for queries, raw text for documents.
 */
function formatText(text: string, hint?: EmbedHint): string {
  if (hint === "query") {
    return `Instruct: Retrieve relevant documents for the given query\nQuery: ${text}`
  }
  return text
}

/**
 * Create a local embedder using node-llama-cpp with GGUF models.
 *
 * Default model: Qwen3-Embedding-0.6B-Q8_0 (1024 dims).
 * Auto-downloads from HuggingFace on first use to ~/.executor/models/.
 *
 * Model loading is lazy — the GGUF model is not loaded until the first
 * embed() call, keeping startup fast.
 */
export async function createLocalEmbedder(
  config: EmbedderConfig,
): Promise<Embedder> {
  const modelName = config.model ?? DEFAULT_MODEL
  const modelUri = config.model
    ? `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/${config.model}.gguf`
    : DEFAULT_MODEL_URI

  // Resolve cache directory (expand ~)
  const cacheDir = MODEL_CACHE_DIR.replace(/^~/, process.env.HOME ?? "")

  // Lazy-loaded state — guarded by a single init promise to prevent races.
  // Types use `any` because node-llama-cpp is dynamically imported.
  let llama: any = null
  let embeddingContexts: any[] = []
  let initPromise: Promise<void> | null = null

  async function ensureLoaded(): Promise<void> {
    if (embeddingContexts.length > 0) return
    if (initPromise) return initPromise

    initPromise = (async () => {
      const { getLlama, resolveModelFile } = await import("node-llama-cpp")

      llama = await getLlama()
      const modelPath = await resolveModelFile(modelUri, cacheDir)
      const model = await llama.loadModel({ modelPath })

      // Determine parallelism: on CPU, use up to 4 contexts (cores / 4)
      const cores = llama.cpuMathCores || 4
      const maxContexts = llama.gpu
        ? 2
        : Math.max(1, Math.min(4, Math.floor(cores / 4)))
      const threads = llama.gpu
        ? 0
        : Math.max(1, Math.floor(cores / maxContexts))

      for (let i = 0; i < maxContexts; i++) {
        try {
          const ctx = await model.createEmbeddingContext({
            ...(threads > 0 ? { threads } : {}),
          })
          embeddingContexts.push(ctx)
        } catch {
          // If we got at least one context, that's fine
          if (embeddingContexts.length === 0) {
            throw new Error("Failed to create any embedding context")
          }
          break
        }
      }
    })()

    try {
      await initPromise
    } finally {
      initPromise = null
    }
  }

  // Detect dimensions from first embedding result
  let detectedDimensions: number | null = null

  const embedder: Embedder = {
    provider: "local",
    model: modelName,

    get dimensions(): number {
      return detectedDimensions ?? config.dimensions ?? DEFAULT_DIMENSIONS
    },

    async embed(text: string, hint?: EmbedHint): Promise<number[]> {
      await ensureLoaded()
      const formatted = formatText(text, hint)
      const ctx = embeddingContexts[0]!
      const result = await ctx.getEmbeddingFor(formatted)
      const vec = Array.from(result.vector as Float32Array) as number[]
      if (!detectedDimensions) detectedDimensions = vec.length
      return vec
    },

    async embedBatch(
      texts: string[],
      hint?: EmbedHint,
    ): Promise<number[][]> {
      if (texts.length === 0) return []
      await ensureLoaded()

      const n = embeddingContexts.length

      if (n === 1) {
        // Single context — sequential embedding
        const ctx = embeddingContexts[0]!
        const results: number[][] = []
        for (const text of texts) {
          const formatted = formatText(text, hint)
          const result = await ctx.getEmbeddingFor(formatted)
          const vec = Array.from(result.vector as Float32Array) as number[]
          if (!detectedDimensions) detectedDimensions = vec.length
          results.push(vec)
        }
        return results
      }

      // Multiple contexts — split texts across contexts for parallel embedding
      const chunkSize = Math.ceil(texts.length / n)
      const chunks = Array.from({ length: n }, (_, i) =>
        texts.slice(i * chunkSize, (i + 1) * chunkSize),
      )

      const chunkResults = await Promise.all(
        chunks.map(async (chunk, i) => {
          const ctx = embeddingContexts[i]!
          const results: number[][] = []
          for (const text of chunk) {
            const formatted = formatText(text, hint)
            const result = await ctx.getEmbeddingFor(formatted)
            const vec = Array.from(result.vector as Float32Array) as number[]
            results.push(vec)
          }
          return results
        }),
      )

      const allResults = chunkResults.flat()
      if (!detectedDimensions && allResults.length > 0) {
        detectedDimensions = allResults[0]!.length
      }
      return allResults
    },
  }

  return embedder
}
