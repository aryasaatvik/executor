import type { AccountId, LocalExecutorConfig, Source } from "#schema";

import * as Effect from "effect/Effect";

import type { ExecutionEnvironment } from "../../execution/state";
import { createCodeExecutorForRuntime, resolveConfiguredExecutionRuntime } from "../../execution/runtime";
import { createWorkspaceToolInvoker } from "../../execution/workspace/tool-invoker";
import type { RuntimeLocalWorkspaceState } from "../../local/runtime-context";
import type { WorkspaceConfigStoreShape } from "../../local/storage";
import type { LocalToolRuntime } from "../../local/tools";
import type { Embedder } from "../../../db/embedder";
import { SourceAuthMaterial } from "../../auth/source-auth-material";
import { SourceAuthService } from "../../sources/source-auth-service";
import { SourceCatalogStore } from "../../catalog/source/runtime";
import { SourceStore } from "../../sources/source-store";
import type { ResolveSecretMaterial } from "../../local/secret-material-providers";

type WorkspaceSourceCatalogManager = {
  getOrRefresh: (input: {
    workspaceId: Source["workspaceId"];
    accountId: AccountId;
    runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
    sourceCatalogStore: Effect.Effect.Success<typeof SourceCatalogStore>;
    workspaceConfigStore: WorkspaceConfigStoreShape;
    embedder?: Embedder;
  }) => Effect.Effect<{ catalog: import("@executor/codemode-core").ToolCatalog; close: Effect.Effect<void, never, never> }, unknown, never>;
};

export const resolveWorkspaceExecutionEnvironment = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  onElicitation?: Parameters<typeof createWorkspaceToolInvoker>[0]["onElicitation"];
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  loadedConfig: LocalExecutorConfig | null | undefined;
  localToolRuntime: LocalToolRuntime;
  embedder?: Embedder;
  workspaceSourceCatalogManager: WorkspaceSourceCatalogManager;
  sourceCatalogStore: Effect.Effect.Success<typeof SourceCatalogStore>;
  sourceStore: Effect.Effect.Success<typeof SourceStore>;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  sourceAuthMaterialService: Effect.Effect.Success<typeof SourceAuthMaterial>;
    sourceAuthService: Effect.Effect.Success<typeof SourceAuthService>;
  resolveSecretMaterial: ResolveSecretMaterial;
  loadConfiguredSemanticSearchEmbedder: (resolveSecretMaterial: ResolveSecretMaterial, config: LocalExecutorConfig | null | undefined, options?: { createEmbedder?: typeof import("../../../db/embedder").createEmbedder }) => Effect.Effect<Embedder | undefined, unknown, never>;
  createWorkspaceToolInvoker: typeof createWorkspaceToolInvoker;
}) =>
  Effect.gen(function* () {
    const managedSourceCatalog = yield* input.workspaceSourceCatalogManager.getOrRefresh({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      runtimeLocalWorkspace: input.runtimeLocalWorkspace,
      sourceCatalogStore: input.sourceCatalogStore,
      workspaceConfigStore: input.workspaceConfigStore,
      embedder: input.embedder,
    });

    const embedder = input.embedder
      ?? (yield* input.loadConfiguredSemanticSearchEmbedder(
        input.resolveSecretMaterial,
        input.loadedConfig,
      ));

    const { catalog, toolInvoker } = input.createWorkspaceToolInvoker({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      sourceCatalogStore: input.sourceCatalogStore,
      sourceStore: input.sourceStore,
      sourceCatalog: managedSourceCatalog.catalog,
      workspaceConfigStore: input.workspaceConfigStore,
      sourceAuthMaterialService: input.sourceAuthMaterialService,
      sourceAuthService: input.sourceAuthService,
      runtimeLocalWorkspace: input.runtimeLocalWorkspace,
      localToolRuntime: input.localToolRuntime,
      embedder,
      onElicitation: input.onElicitation,
    });

    const executor = createCodeExecutorForRuntime(
      resolveConfiguredExecutionRuntime(input.loadedConfig),
    );

    return {
      executor,
      toolInvoker,
      catalog,
    } satisfies ExecutionEnvironment;
  });
