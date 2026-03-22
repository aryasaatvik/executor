import {
  createSystemToolMap,
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
  mergeToolCatalogs,
  mergeToolMaps,
  type ToolCatalog,
  type ToolInvoker,
} from "@executor/codemode-core";
import type { AccountId, Source } from "#schema";
import * as Effect from "effect/Effect";

import { RuntimeSourceAuthMaterialService } from "../../auth/source-auth-material";
import { RuntimeSourceCatalogStoreService } from "../../catalog/source/runtime";
import type { RuntimeLocalWorkspaceState } from "../../local/runtime-context";
import {
  type LocalToolRuntime,
} from "../../local/tools";
import {
  makeWorkspaceStorageLayer,
  type SourceArtifactStoreShape,
  type WorkspaceConfigStoreShape,
  type WorkspaceStateStoreShape,
} from "../../local/storage";
import {
  RuntimeSourceAuthService,
} from "../../sources/source-auth-service";
import { createExecutorToolMap } from "../../sources/executor-tools";
import { invokeIrTool } from "../ir-execution";
import type { Embedder } from "../../../db/embedder";
import {
  authorizePersistedToolInvocation,
  toSecretResolutionContext,
} from "./authorization";
import { provideRuntimeLocalWorkspace } from "./local";
import {
  loadWorkspaceCatalogToolByPath,
} from "./source-catalog";
import { runtimeEffectError } from "../../effect-errors";

export const createWorkspaceToolInvoker = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  sourceCatalog: ToolCatalog;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  sourceAuthMaterialService: Effect.Effect.Success<typeof RuntimeSourceAuthMaterialService>;
  sourceAuthService: RuntimeSourceAuthService;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null;
  localToolRuntime: LocalToolRuntime;
  embedder?: Embedder;
  onElicitation?: Parameters<
    typeof makeToolInvokerFromTools
  >[0]["onElicitation"];
}): {
  catalog: ToolCatalog;
  toolInvoker: ToolInvoker;
} => {
  const workspaceStorageLayer = makeWorkspaceStorageLayer({
    workspaceConfigStore: input.workspaceConfigStore,
    workspaceStateStore: input.workspaceStateStore,
    sourceArtifactStore: input.sourceArtifactStore,
  });
  const provideWorkspaceStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(workspaceStorageLayer));

  const executorTools = createExecutorToolMap({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    sourceAuthService: input.sourceAuthService,
    runtimeLocalWorkspace: input.runtimeLocalWorkspace,
  });
  let catalog: ToolCatalog | null = null;
  const systemTools = createSystemToolMap({
    getCatalog: () => {
      if (catalog === null) {
        throw new Error("Workspace tool catalog has not been initialized");
      }

      return catalog;
    },
  });
  const authoredTools = mergeToolMaps([
    systemTools,
    executorTools,
    input.localToolRuntime.tools,
  ]);
  const authoredCatalog = createToolCatalogFromTools({
    tools: authoredTools,
  });
  catalog = mergeToolCatalogs({
    catalogs: [authoredCatalog, input.sourceCatalog],
  });
  const authoredToolPaths = new Set(Object.keys(authoredTools));
  const authoredInvoker = makeToolInvokerFromTools({
    tools: authoredTools,
    onElicitation: input.onElicitation,
  });

  const invokePersistedTool = (invocation: {
    path: string;
    args: unknown;
    context?: Record<string, unknown>;
  }) =>
    provideRuntimeLocalWorkspace(
      provideWorkspaceStorage(Effect.gen(function* () {
        const catalogTool = yield* loadWorkspaceCatalogToolByPath({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          sourceCatalogStore: input.sourceCatalogStore,
          path: invocation.path,
          includeSchemas: false,
        });
        if (!catalogTool) {
          return yield* runtimeEffectError("execution/workspace/tool-invoker", `Unknown tool path: ${invocation.path}`);
        }

        yield* authorizePersistedToolInvocation({
          workspaceId: input.workspaceId,
          tool: catalogTool,
          args: invocation.args,
          context: invocation.context,
          onElicitation: input.onElicitation,
        });

        const auth = yield* input.sourceAuthMaterialService.resolve({
          source: catalogTool.source,
          actorAccountId: input.accountId,
          context: toSecretResolutionContext(invocation.context),
        });
        return yield* invokeIrTool({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          tool: catalogTool,
          auth,
          args: invocation.args,
          onElicitation: input.onElicitation,
          context: invocation.context,
        });
      })),
      input.runtimeLocalWorkspace,
    );

  return {
    catalog,
    toolInvoker: {
      invoke: ({ path, args, context }) =>
        provideRuntimeLocalWorkspace(
          authoredToolPaths.has(path)
            ? authoredInvoker.invoke({ path, args, context })
            : invokePersistedTool({ path, args, context }),
          input.runtimeLocalWorkspace,
        ),
    },
  };
};
