import { afterEach, describe, expect, it, vi } from "vitest"

import { validateSemanticSearchConfigForWrite } from "./semantic-search-config"

describe("validateSemanticSearchConfigForWrite", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("rejects cloud semantic search config without a secret ref", () => {
    expect(
      validateSemanticSearchConfigForWrite({
        provider: "google",
        model: "gemini-embedding-2-preview",
      }),
    ).toContain("requires an apiKeyRef secret")
  })

  it("accepts cloud semantic search config with a secret ref", () => {
    expect(
      validateSemanticSearchConfigForWrite({
        provider: "openai",
        model: "text-embedding-3-small",
        apiKeyRef: {
          providerId: "local",
          handle: "secret_123",
        },
      }),
    ).toBeNull()
  })

  it("accepts local semantic search config without credentials", () => {
    expect(
      validateSemanticSearchConfigForWrite({
        provider: "local",
        model: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      }),
    ).toBeNull()
  })

  it("rejects local semantic search config with an api key ref", () => {
    expect(
      validateSemanticSearchConfigForWrite({
        provider: "local",
        model: "Qwen3-Embedding-0.6B-Q8_0.gguf",
        apiKeyRef: {
          providerId: "local",
          handle: "secret_123",
        },
      }),
    ).toContain('does not accept "apiKeyRef"')
  })
})
