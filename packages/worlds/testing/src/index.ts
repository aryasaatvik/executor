import type { ExecutorWorld } from "@executor/control-plane/world";

import {
  createInMemoryExecutionStore,
  createInMemorySourceStore,
  createInMemoryCatalogStore,
  createInMemorySecretStore,
  createInMemoryAuthArtifactStore,
  createInMemorySemanticSearch,
  createInMemoryInteractionBus,
  createInMemoryRuntimeRegistry,
  createInMemoryWorkspaceConfig,
} from "./in-memory-stores";

/**
 * Create a fully in-memory ExecutorWorld for testing.
 * All stores are isolated per call — no shared state between tests.
 */
export const createTestWorld = (): ExecutorWorld => ({
  executionStore: createInMemoryExecutionStore(),
  sourceStore: createInMemorySourceStore(),
  catalogStore: createInMemoryCatalogStore(),
  secretStore: createInMemorySecretStore(),
  authStore: createInMemoryAuthArtifactStore(),
  search: createInMemorySemanticSearch(),
  interactions: createInMemoryInteractionBus(),
  runtimes: createInMemoryRuntimeRegistry(),
  config: createInMemoryWorkspaceConfig(),
});

export {
  createInMemoryExecutionStore,
  createInMemorySourceStore,
  createInMemoryCatalogStore,
  createInMemorySecretStore,
  createInMemoryAuthArtifactStore,
  createInMemorySemanticSearch,
  createInMemoryInteractionBus,
  createInMemoryRuntimeRegistry,
  createInMemoryWorkspaceConfig,
} from "./in-memory-stores";
