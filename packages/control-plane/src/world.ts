import type * as Effect from "effect/Effect";

import type { ExecutionStoreShape } from "./ports/execution-store";
import type { SourceStoreShape } from "./ports/source-store";
import type { CatalogStoreShape } from "./ports/catalog-store";
import type { SecretStoreShape } from "./ports/secret-store";
import type { AuthArtifactStoreShape } from "./ports/auth-artifact-store";
import type { SemanticSearchShape } from "./ports/semantic-search";
import type { InteractionBusShape } from "./ports/interaction-bus";
import type { RuntimeRegistryShape } from "./ports/runtime-registry";
import type { WorkspaceConfigShape } from "./ports/workspace-config";

export interface ExecutorWorld {
  readonly executionStore: ExecutionStoreShape;
  readonly sourceStore: SourceStoreShape;
  readonly catalogStore: CatalogStoreShape;
  readonly secretStore: SecretStoreShape;
  readonly authStore: AuthArtifactStoreShape;
  readonly search: SemanticSearchShape;
  readonly interactions: InteractionBusShape;
  readonly runtimes: RuntimeRegistryShape;
  readonly config: WorkspaceConfigShape;

  start?(): Effect.Effect<void, Error>;
  close?(): Effect.Effect<void, Error>;
}
