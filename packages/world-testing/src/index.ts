import type { ExecutorWorld } from "@executor/core/world";
import { SqliteClient } from "@effect/sql-sqlite-bun";

/**
 * Create a fully in-memory ExecutorWorld for testing.
 * Each call gets an isolated :memory: SQLite database.
 */
export const createTestWorld = (): ExecutorWorld => ({
  database: SqliteClient.layer({ filename: ":memory:" }),
  // No vector search or embedder in tests by default
});

// Legacy in-memory stores — kept for existing tests during migration
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
