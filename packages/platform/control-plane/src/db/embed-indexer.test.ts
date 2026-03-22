import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { vi } from "vitest"

const { removeVecToolsMock, upsertVecToolMock } = vi.hoisted(() => ({
  removeVecToolsMock: vi.fn(),
  upsertVecToolMock: vi.fn(),
}))

vi.mock("./vec", () => ({
  removeVecSourceTools: vi.fn(),
  removeVecTools: removeVecToolsMock,
  upsertVecTool: upsertVecToolMock,
}))

import { buildEmbeddingText, embedSourceTools } from "./embed-indexer"
import type { ToolToIndex } from "./indexer"

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

describe("embedSourceTools", () => {
  it.effect("removes stale vectors for tools whose embedding fails", () =>
    Effect.gen(function* () {
      removeVecToolsMock.mockReset()
      upsertVecToolMock.mockReset()
      removeVecToolsMock.mockReturnValue(Effect.void)
      upsertVecToolMock.mockReturnValue(Effect.void)

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
      })

      expect(upsertVecToolMock).toHaveBeenCalledTimes(1)
      expect(upsertVecToolMock).toHaveBeenCalledWith({
        toolId: "github.issues.create",
        embedding: [1, 2, 3],
        sourceKey: "github",
        namespace: "github.issues",
      })
      expect(removeVecToolsMock).toHaveBeenCalledTimes(1)
      expect(removeVecToolsMock).toHaveBeenCalledWith([
        "github.issues.update",
      ])
    }),
  )
})
