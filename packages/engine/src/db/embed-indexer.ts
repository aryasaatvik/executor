import * as Effect from "effect/Effect"
import type { Embedder } from "./embedder/types"
import type { ToolToIndex } from "./indexer"
import {
  VecService,
} from "./vec"

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
    const vec = yield* VecService

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

      const failedToolIds = batch
        .filter((_, index) => !embeddings[index] || embeddings[index].length === 0)
        .map((tool) => tool.toolId)

      if (failedToolIds.length > 0) {
        yield* vec.removeVecTools(failedToolIds)
      }

      // Upsert into vector table
      for (let j = 0; j < batch.length; j++) {
        if (embeddings[j] && embeddings[j].length > 0) {
          yield* vec.upsertVecTool({
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
  Effect.gen(function* () {
    const vec = yield* VecService
    yield* vec.removeVecSourceTools(sourceKey)
  })

/**
 * Build the text to embed for a tool.
 * Simple format -- one embedding per tool, no chunking needed.
 */
export function buildEmbeddingText(tool: ToolToIndex): string {
  const parts: string[] = []
  if (tool.searchText) {
    parts.push(tool.searchText)
  } else {
    if (tool.title) parts.push(tool.title)
    if (tool.description) parts.push(tool.description)
    parts.push(tool.path)
  }
  const params = extractParams(tool.inputSchemaJson)
  if (params.length > 0) {
    parts.push(`params: ${params.join(" ")}`)
  }
  return parts.join("\n")
}

const extractParams = (schema: unknown): string[] => {
  if (
    schema === null ||
    schema === undefined ||
    typeof schema !== "object"
  ) {
    return []
  }

  const obj = schema as Record<string, unknown>
  const properties = obj.properties
  if (
    properties === null ||
    properties === undefined ||
    typeof properties !== "object"
  ) {
    return []
  }

  const props = properties as Record<string, unknown>
  return Object.entries(props).map(([name, def]) => {
    const typeName =
      def !== null &&
      def !== undefined &&
      typeof def === "object" &&
      "type" in def &&
      typeof (def as Record<string, unknown>).type === "string"
        ? ` (${(def as Record<string, unknown>).type as string})`
        : ""
    return `${name}${typeName}`
  })
}
