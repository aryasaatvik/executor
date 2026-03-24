import type { InstanceConfig } from "./api"

export const validateSemanticSearchConfigForWrite = (
  semanticSearch: InstanceConfig["semanticSearch"],
): string | null => {
  if (!semanticSearch) {
    return null
  }

  if (semanticSearch.provider === "local") {
    if (semanticSearch.apiKeyRef !== undefined) {
      return 'Local semantic search does not accept "apiKeyRef".'
    }
    return null
  }

  if (
    semanticSearch.provider !== "google" &&
    semanticSearch.provider !== "openai"
  ) {
    return `Semantic search provider "${semanticSearch.provider}" is not supported for saved local config.`
  }

  if (
    semanticSearch.apiKeyRef?.providerId?.trim() &&
    semanticSearch.apiKeyRef?.handle?.trim()
  ) {
    return null
  }

  return `Semantic search provider "${semanticSearch.provider}" requires an apiKeyRef secret.`
}
