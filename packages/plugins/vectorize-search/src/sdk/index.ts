export {
  vectorizeSearchPlugin,
  type VectorizeSearchPluginOptions,
  type VectorizeSearchExtension,
} from "./plugin";
export { makeVectorizeToolDiscoveryProvider, MAX_METADATA_TOP_K } from "./provider";
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
  MAX_TOP_K,
} from "./vectorize";
export { reconcileToolCatalog, type ReconcileResult } from "./indexer";
export { VectorizeSearchError } from "./errors";

// Chunker
export {
  makeFacetChunker,
  makeWholeChunker,
  type Chunker,
  type ToolDocumentInput,
  type ToolChunk,
  type ChunkFacet,
  type FacetChunkerOptions,
} from "./chunker";
export { ChunkerService, facetChunkerLayer, wholeChunkerLayer } from "./chunker-service";

// Hybrid RRF provider
export { makeHybridToolDiscoveryProvider, type HybridOptions } from "./hybrid";

// Fingerprint
export { fingerprintTool, type FingerprintInput } from "./fingerprint";

// Collections (plugin storage)
export { toolFingerprints, FingerprintRow } from "./collections";

// Store limit decorator
export { withCloudflareLimits } from "./store-cloudflare-limits";
