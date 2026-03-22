import { describe, expect, it } from "@effect/vitest"

import { buildEmbeddingText } from "./embed-indexer"
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
