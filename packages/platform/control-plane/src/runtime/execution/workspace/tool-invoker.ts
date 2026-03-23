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
import * as Layer from "effect/Layer";
import { SourceStore } from "../../sources/source-store";

import { SourceAuthMaterial } from "../../auth/source-auth-material";
import { SourceCatalogStore } from "../../catalog/source/runtime";
import type { RuntimeLocalWorkspaceState } from "../../local/runtime-context";
import {
  type LocalToolRuntime,
} from "../../local/tools";
import {
  WorkspaceConfigStore as WorkspaceConfigStoreTag,
  type WorkspaceConfigStoreShape,
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
  loadWorkspaceCatalogToolByPathFromDb,
} from "./source-catalog";
import { runtimeEffectError } from "../../effect-errors";

export const createWorkspaceToolInvoker = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: Effect.Effect.Success<typeof SourceCatalogStore>;
  sourceStore: Effect.Effect.Success<typeof SourceStore>;
  sourceCatalog: ToolCatalog;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  sourceAuthMaterialService: Effect.Effect.Success<typeof SourceAuthMaterial>;
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
  const workspaceConfigLayer = Layer.succeed(
    WorkspaceConfigStoreTag,
    input.workspaceConfigStore,
  );
  const provideWorkspaceStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(workspaceConfigLayer));

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
  const localUserCatalog = createToolCatalogFromTools({
    tools: input.localToolRuntime.tools,
  });
  const executorCatalog = createToolCatalogFromTools({
    tools: executorTools,
  });
  const systemHelperCatalog = createToolCatalogFromTools({
    tools: systemTools,
  });
  catalog = mergeToolCatalogs({
    catalogs: [
      { catalog: localUserCatalog, role: "local_user" },
      { catalog: input.sourceCatalog, role: "persisted_source" },
      { catalog: executorCatalog, role: "executor" },
      { catalog: systemHelperCatalog, role: "system_helper" },
    ],
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
        // Prefer DB-backed loading when a local workspace is available
        const catalogTool = input.runtimeLocalWorkspace
          ? yield* loadWorkspaceCatalogToolByPathFromDb({
              workspaceId: input.workspaceId,
              accountId: input.accountId,
              path: invocation.path,
              runtimeLocalWorkspace: input.runtimeLocalWorkspace,
              sourceStore: input.sourceStore,
            })
          : yield* loadWorkspaceCatalogToolByPath({
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
        ) as Effect.Effect<unknown, unknown, never>,
    },
  };
};
