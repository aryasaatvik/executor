import { afterEach, describe, expect, it, vi } from "vitest"

import { validateSemanticSearchConfigForWrite } from "./semantic-search-config"

describe("validateSemanticSearchConfigForWrite", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("rejects cloud semantic search config without any credential source", () => {
    const previousGoogleApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    const previousGeminiApiKey = process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    delete process.env.GEMINI_API_KEY

    try {
      expect(
        validateSemanticSearchConfigForWrite({
          provider: "google",
          model: "gemini-embedding-2-preview",
        }),
      ).toContain("requires an API key")
    } finally {
      if (previousGoogleApiKey !== undefined) {
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousGoogleApiKey
      }
      if (previousGeminiApiKey !== undefined) {
        process.env.GEMINI_API_KEY = previousGeminiApiKey
      }
    }
  })

  it("accepts cloud semantic search config when the API key comes from the environment", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test")

    expect(
      validateSemanticSearchConfigForWrite({
        provider: "openai",
        model: "text-embedding-3-small",
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
})
