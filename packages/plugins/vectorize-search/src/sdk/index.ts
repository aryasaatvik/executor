export {
  vectorizeSearchPlugin,
  type VectorizeSearchPluginOptions,
  type VectorizeSearchExtension,
} from "./plugin";
export { makeVectorizeToolDiscoveryProvider } from "./provider";
export {
  makeGeminiEmbedder,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
  type ToolEmbedder,
  type GeminiEmbedderOptions,
} from "./embedder";
export {
  makeVectorizeStore,
  type VectorizeIndex,
  type VectorizeStore,
  type VectorizeMatch,
  type VectorizeMatches,
  type VectorizeVectorInput,
} from "./vectorize";
export { reindexToolCatalog, collectToolDocuments, type ReindexResult } from "./indexer";
export { projectToolDocument, toolVectorId, type ToolSearchDocument } from "./documents";
export { VectorizeSearchError } from "./errors";
