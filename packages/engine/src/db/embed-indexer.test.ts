import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { vi } from "vitest"

import { buildEmbeddingText, embedSourceTools } from "./embed-indexer"
import type { ToolToIndex } from "./indexer"
import { VecService, type VecServiceShape } from "./vec"

describe("buildEmbeddingText", () => {
  it("embeds the richer runtime search document and params", () => {
    const tool: ToolToIndex = {
      toolId: "github.issues.create",
      path: "github.issues.create",
      sourceId: "source-github",
      sourceKey: "github",
      namespace: "github.issues",
      searchText:
        "github.issues.create github.issues GitHub Create Issue streamable-http oauth RequestConfig Result",
      title: "Create Issue",
      description: "Create a GitHub issue",
      inputSchemaJson: {
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
        },
      },
    }

    const text = buildEmbeddingText(tool)

    expect(text).toContain(tool.searchText)
    expect(text).toContain("params: owner (string) repo (string)")
  })
})

const makeVecLayer = (overrides: {
  removeVecTools?: VecServiceShape["removeVecTools"]
  upsertVecTool?: VecServiceShape["upsertVecTool"]
} = {}) => {
  const removeVecTools =
    overrides.removeVecTools ?? vi.fn(() => Effect.void)
  const upsertVecTool =
    overrides.upsertVecTool ?? vi.fn(() => Effect.void)

  return {
    removeVecTools,
    upsertVecTool,
    layer: Layer.succeed(VecService, {
      hasVecTable: () => Effect.succeed(false),
      setupVecTable: () => Effect.void,
      getVecTableDimensions: Effect.succeed(null),
      dropVecTable: Effect.void,
      searchVec: () => Effect.succeed([]),
      upsertVecTool,
      removeVecSourceTools: () => Effect.void,
      removeVecTools,
    } satisfies VecServiceShape),
  }
}

describe("embedSourceTools", () => {
  it.effect("removes stale vectors for tools whose embedding fails", () =>
    Effect.gen(function* () {
      const vecLayer = makeVecLayer()

      yield* embedSourceTools({
        embedder: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 3,
          embedBatch: async () => {
            throw new Error("batch failed")
          },
          embed: async (text: string) => {
            if (text.includes("update")) {
              throw new Error("single failed")
            }
            return [1, 2, 3]
          },
        },
        sourceKey: "github",
        tools: [
          {
            toolId: "github.issues.create",
            path: "github.issues.create",
            sourceId: "source-github",
            sourceKey: "github",
            namespace: "github.issues",
            searchText: "github issues create",
            title: "Create issue",
            description: "Create a GitHub issue",
            inputSchemaJson: undefined,
          },
          {
            toolId: "github.issues.update",
            path: "github.issues.update",
            sourceId: "source-github",
            sourceKey: "github",
            namespace: "github.issues",
            searchText: "github issues update",
            title: "Update issue",
            description: "Update a GitHub issue",
            inputSchemaJson: undefined,
          },
        ] satisfies readonly ToolToIndex[],
      }).pipe(Effect.provide(vecLayer.layer))

      expect(vecLayer.upsertVecTool).toHaveBeenCalledTimes(1)
      expect(vecLayer.upsertVecTool).toHaveBeenCalledWith({
        toolId: "github.issues.create",
        embedding: [1, 2, 3],
        sourceKey: "github",
        namespace: "github.issues",
      })
      expect(vecLayer.removeVecTools).toHaveBeenCalledTimes(1)
      expect(vecLayer.removeVecTools).toHaveBeenCalledWith([
        "github.issues.update",
      ])
    }),
  )
})
