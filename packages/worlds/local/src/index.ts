import * as Effect from "effect/Effect";
import type { ExecutorWorld } from "@executor/control-plane/world";

import { createSqliteExecutionStore } from "./stores/execution-store";
import { createSqliteSourceStore } from "./stores/source-store";
import { createSqliteCatalogStore } from "./stores/catalog-store";
import { createLocalSecretStore } from "./stores/secret-store";
import { createSqliteAuthStore } from "./stores/auth-artifact-store";
import { createSqliteVecSearch } from "./search/semantic-search";
import { createInMemoryInteractionBus } from "./bus/interaction-bus";
import { createLocalRuntimeRegistry } from "./registry/runtime-registry";
import { createLocalWorkspaceConfig } from "./config/workspace-config";

export interface LocalConfig {
  readonly dataDir: string;
}

export const createLocalWorld = (_config: LocalConfig): ExecutorWorld => ({
  executionStore: createSqliteExecutionStore(),
  sourceStore: createSqliteSourceStore(),
  catalogStore: createSqliteCatalogStore(),
  secretStore: createLocalSecretStore(),
  authStore: createSqliteAuthStore(),
  search: createSqliteVecSearch(),
  interactions: createInMemoryInteractionBus(),
  runtimes: createLocalRuntimeRegistry(),
  config: createLocalWorkspaceConfig(),

  start: () => Effect.void,
  close: () => Effect.void,
});
