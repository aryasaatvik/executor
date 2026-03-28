import * as Effect from "effect/Effect"

import { VecService } from "./vec"

type ToolToEmbed = {
  toolId: string
  namespace: string
  searchText?: string
  title?: string
  description?: string
  path: string
  inputSchemaJson?: unknown
}

type Embedder = {
  embed: (text: string, mode: "query" | "document") => Promise<number[]>
  embedBatch: (texts: readonly string[], mode: "query" | "document") => Promise<number[][]>
}

const BATCH_SIZE = 32

export const embedSourceTools = (input: {
  embedder: Embedder
  tools: readonly ToolToEmbed[]
  sourceKey: string
}) =>
  Effect.gen(function* () {
    const { embedder, tools, sourceKey } = input
    const vec = yield* VecService

    for (let i = 0; i < tools.length; i += BATCH_SIZE) {
      const batch = tools.slice(i, i + BATCH_SIZE)
      const texts = batch.map((tool) => buildEmbeddingText(tool))

      const embeddings = yield* Effect.tryPromise({
        try: () => embedder.embedBatch(texts, "document"),
        catch: () => new Error("Batch embedding failed"),
      }).pipe(
        Effect.catchAll(() =>
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

export const removeSourceEmbeddings = (sourceKey: string) =>
  Effect.gen(function* () {
    const vec = yield* VecService
    yield* vec.removeVecSourceTools(sourceKey)
  })

export function buildEmbeddingText(tool: ToolToEmbed): string {
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
  if (schema === null || schema === undefined || typeof schema !== "object") {
    return []
  }

  const obj = schema as Record<string, unknown>
  const properties = obj.properties
  if (properties === null || properties === undefined || typeof properties !== "object") {
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
