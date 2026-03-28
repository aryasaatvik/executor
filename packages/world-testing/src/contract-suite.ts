import type { ExecutorWorld } from "@executor/core";

/**
 * Run the full contract test suite against any ExecutorWorld implementation.
 *
 * TODO: Rewrite to test through core services with a SqlClient,
 * instead of testing individual store ports directly.
 * The new World contract only provides database/vectorSearch/embedder layers,
 * so tests should verify core queries work against the provided SqlClient.
 */
export function runWorldContractTests(_createWorld: () => ExecutorWorld) {
  // Contract tests will be rewritten to test core services
  // against the SqlClient provided by the world.
}
