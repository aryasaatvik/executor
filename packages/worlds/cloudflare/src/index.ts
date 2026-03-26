import type { ExecutorWorld } from "@executor/control-plane/world";

import { createD1ExecutionStore } from "./stores/execution-store";
import { createD1SourceStore } from "./stores/source-store";
import { createD1CatalogStore } from "./stores/catalog-store";
import { createKvSecretStore } from "./stores/secret-store";
import { createD1AuthArtifactStore } from "./stores/auth-artifact-store";
import { createVectorizeSearch } from "./search/vectorize-search";
import { createDurableObjectInteractionBus } from "./bus/durable-object-interaction-bus";
import { createDynamicWorkerRegistry } from "./registry/dynamic-worker-registry";
import { createKvWorkspaceConfig } from "./config/workspace-config";

// ---------------------------------------------------------------------------
// Cloudflare environment bindings (placeholder for Phase 6)
// ---------------------------------------------------------------------------

export interface CloudflareEnv {
  readonly DB: unknown;         // D1Database binding
  readonly KV: unknown;         // KVNamespace binding
  readonly R2: unknown;         // R2Bucket binding
  readonly DO: unknown;         // DurableObjectNamespace binding
  readonly VECTORIZE: unknown;  // VectorizeIndex binding
}

// ---------------------------------------------------------------------------
// Cloudflare world factory
// ---------------------------------------------------------------------------

export const createCloudflareWorld = (_env: CloudflareEnv): ExecutorWorld => ({
  executionStore: createD1ExecutionStore(),
  sourceStore: createD1SourceStore(),
  catalogStore: createD1CatalogStore(),
  secretStore: createKvSecretStore(),
  authStore: createD1AuthArtifactStore(),
  search: createVectorizeSearch(),
  interactions: createDurableObjectInteractionBus(),
  runtimes: createDynamicWorkerRegistry(),
  config: createKvWorkspaceConfig(),
});
