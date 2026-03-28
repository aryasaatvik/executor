// Core ports — the ExecutorWorld contract
export { VectorSearch, type VectorSearchShape, type VectorSearchResult } from "./vector-search";
export { Embedder, type EmbedderShape } from "./embedder";

// Internal service tags — used by core services, not part of World contract
export { ExecutionStore, type ExecutionStoreShape } from "./execution-store";
export { SourceStore, type SourceStoreShape } from "./source-store";
export { CatalogStore, type CatalogStoreShape } from "./catalog-store";
export { SecretStore, type SecretStoreShape } from "./secret-store";
export { AuthArtifactStore, type AuthArtifactStoreShape } from "./auth-artifact-store";
export { SemanticSearch, type SemanticSearchShape } from "./semantic-search";
export { InteractionBus, type InteractionBusShape } from "./interaction-bus";
export { RuntimeRegistry, type RuntimeRegistryShape } from "./runtime-registry";
export { WorkspaceConfig, type WorkspaceConfigShape } from "./workspace-config";
