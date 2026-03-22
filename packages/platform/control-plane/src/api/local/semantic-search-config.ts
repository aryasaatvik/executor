import type { InstanceConfig } from "./api"

const SEMANTIC_SEARCH_ENV_KEYS: Record<string, readonly string[]> = {
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
}

export const validateSemanticSearchConfigForWrite = (
  semanticSearch: InstanceConfig["semanticSearch"],
): string | null => {
  if (!semanticSearch) {
    return null
  }

  if (semanticSearch.provider === "local") {
    return null
  }

  const inlineApiKey = semanticSearch.apiKey?.trim()
  if (inlineApiKey) {
    return null
  }

  const envKeys = SEMANTIC_SEARCH_ENV_KEYS[semanticSearch.provider] ?? []
  if (envKeys.some((key) => {
    const value = process.env[key]
    return typeof value === "string" && value.trim().length > 0
  })) {
    return null
  }

  if (envKeys.length === 0) {
    return `Semantic search provider "${semanticSearch.provider}" is not supported for saved local config.`
  }

  return `Semantic search provider "${semanticSearch.provider}" requires an API key in Settings or one of: ${envKeys.join(", ")}`
}
