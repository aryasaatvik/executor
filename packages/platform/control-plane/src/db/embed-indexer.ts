import * as Effect from "effect/Effect"
import type { Embedder } from "./embedder/types"
import type { ToolToIndex } from "./indexer"
import { upsertVecTool, removeVecSourceTools } from "./vec"

const BATCH_SIZE = 32

/**
 * Embed and index tools into the vector table.
 *
 * Only tools passed in (typically those whose content_hash changed) are
 * embedded. Batches in groups of 32 with individual retry on batch failure.
 */
export const embedSourceTools = (input: {
  embedder: Embedder
  tools: readonly ToolToIndex[]
  sourceKey: string
}) =>
  Effect.gen(function* () {
    const { embedder, tools, sourceKey } = input

    // Batch embed
    for (let i = 0; i < tools.length; i += BATCH_SIZE) {
      const batch = tools.slice(i, i + BATCH_SIZE)
      const texts = batch.map((t) => buildEmbeddingText(t))

      // Try batch embedding first, fall back to individual on failure
      const embeddings = yield* Effect.tryPromise({
        try: () => embedder.embedBatch(texts, "document"),
        catch: () => new Error("Batch embedding failed"),
      }).pipe(
        Effect.catchAll(() =>
          // Batch failed -- retry individually
          Effect.gen(function* () {
            const results: number[][] = []
            for (const text of texts) {
              const single = yield* Effect.tryPromise({
                try: () => embedder.embed(text, "document"),
                catch: () => new Error("Individual embedding failed"),
              }).pipe(Effect.catchAll(() => Effect.succeed([] as number[])))
              results.push(single)
            }
            return results
          }),
        ),
      )

      // Upsert into vector table
      for (let j = 0; j < batch.length; j++) {
        if (embeddings[j] && embeddings[j].length > 0) {
          yield* upsertVecTool({
            toolId: batch[j].toolId,
            embedding: embeddings[j],
            sourceKey,
            namespace: batch[j].namespace,
          })
        }
      }
    }
  })

/**
 * Remove all embeddings for a source from the vector table.
 */
export const removeSourceEmbeddings = (sourceKey: string) =>
  removeVecSourceTools(sourceKey)

/**
 * Build the text to embed for a tool.
 * Simple format -- one embedding per tool, no chunking needed.
 */
function buildEmbeddingText(tool: ToolToIndex): string {
  const parts: string[] = []
  if (tool.title) parts.push(tool.title)
  if (tool.description) parts.push(tool.description)
  parts.push(tool.path)
  return parts.join("\n")
}
