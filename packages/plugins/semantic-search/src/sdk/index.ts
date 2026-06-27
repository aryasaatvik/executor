export {
  semanticSearchPlugin,
  type SemanticSearchPluginOptions,
  type SemanticSearchExtension,
} from "./plugin";
export {
  ToolSearchBackend,
  makeVectorToolSearchBackend,
  type SemanticSearchRefreshResult,
  type SemanticSearchReindexBatchInput,
  type SemanticSearchReindexBatchResult,
  type SemanticSearchResultPage,
  type SemanticSearchStatus,
  type ToolSearchBackend as ToolSearchBackendType,
  type ToolSearchBackendFactory,
  type VectorToolSearchBackendStorage,
  type VectorToolSearchBackendOptions,
} from "./tool-search-backend";
export {
  makeAiSearchToolDiscoveryProvider,
  makeAiSearchToolSearchBackend,
  reindexAiSearch,
  reindexAiSearchBatch,
  statusAiSearch,
  type AiSearchToolSearchBackendOptions,
  type AiSearchToolSearchBackendStorage,
} from "./ai-search";
export { makeVectorToolDiscoveryProvider } from "./provider";
export { makeEmbedder, type ToolEmbedder, type MakeEmbedderOptions } from "./embedder";
export { makeHashEmbedder } from "./embedder-hash";
export { type VectorStore, type VectorMatch, type VectorMatches, type VectorInput } from "./store";
export { makeVectorizeStore, type VectorizeIndex, MAX_TOP_K } from "./store-cloudflare";
export {
  ToolSearchIndex,
  create,
  scan,
  chunk,
  embed,
  commit,
  status,
  complete,
  run,
  make as makeToolSearchIndex,
  sweepRemoved,
} from "./tool-search-index";
export { SemanticSearchError } from "./errors";

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
export {
  aiSearchItems,
  AiSearchItemRow,
  AiSearchItemStatus,
  toolFingerprints,
  indexRuns,
  indexJobs,
  indexChunks,
  type AiSearchItemRow as AiSearchItemRowType,
  type AiSearchItemStatus as AiSearchItemStatusType,
  FingerprintRow,
  IndexRun,
  IndexJob,
  IndexChunk,
} from "./collections";

// Store limit decorator
export { withCloudflareLimits } from "./store-cloudflare-limits";

// zvec store (local / dev)
export { makeZVecStore, type ZVecStoreOptions } from "./store-zvec";

// sqlite-vec store (local / dev)
export { makeSqliteVecStore, type SqliteVecStoreOptions } from "./store-sqlite-vec";

// FTS5 lexical store + provider (local / dev)
export {
  makeFtsLexicalStore,
  makeFtsLexicalProvider,
  type FtsLexicalStore,
  type FtsDocumentInput,
  type FtsSearchInput,
  type FtsSearchResult,
} from "./store-fts";

// FTS5 lexical store backed by Cloudflare D1
export { makeD1FtsLexicalStore, type D1Database, type D1PreparedStatement } from "./store-fts-d1";

// Documents projector helpers
export { stripHtml, buildLexicalText } from "./documents";
