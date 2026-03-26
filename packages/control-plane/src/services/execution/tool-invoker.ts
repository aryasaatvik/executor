// TODO: This file has extensive engine-internal dependencies that must be
// resolved as services migrate. Many imports reference engine runtime
// internals that are not available via @executor/engine package exports.

import {
  createSystemToolMap,
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
  mergeToolCatalogs,
  mergeToolMaps,
  type ToolCatalog,
  type ToolInvoker,
  type ToolMap,
} from "@executor/codemode-core";
import type { AccountId, Source } from "../../model/index";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LoadedSourceCatalogToolIndexEntry } from "./ir-execution";
import { invocationDescriptorFromTool, invokeIrTool } from "./ir-execution";
import {
  authorizePersistedToolInvocation,
  toSecretResolutionContext,
} from "./authorization";
import { runtimeEffectError } from "./effect-errors";

// TODO: These engine-internal types should be replaced with control-plane
// port interfaces. For now, define minimal placeholder types.

/** Placeholder — engine's RuntimeLocalWorkspaceState */
export type RuntimeLocalWorkspaceState = {
  context: {
    stateDirectory: string;
    [key: string]: unknown;
  };
  installation: {
    workspaceId: Source["workspaceId"];
    accountId: AccountId;
  };
  loadedConfig?: unknown;
  [key: string]: unknown;
} | null;

/** Placeholder — engine's LocalToolRuntime */
export type LocalToolRuntime = {
  tools: ToolMap;
  [key: string]: unknown;
};

/** Placeholder — engine's SourceAuthMaterial service shape */
type SourceAuthMaterialShape = {
  resolve: (input: {
    source: unknown;
    actorAccountId: AccountId;
    context?: unknown;
  }) => Effect.Effect<unknown, unknown>;
};

/** Placeholder — engine's RuntimeSourceAuthService */
type RuntimeSourceAuthService = unknown;

/** Placeholder — engine's SourceCatalogStore service shape */
type SourceCatalogStoreShape = {
  loadWorkspaceSourceCatalogToolByPath: (input: {
    workspaceId: Source["workspaceId"];
    path: string;
    actorAccountId: AccountId;
    includeSchemas: boolean;
  }) => Effect.Effect<LoadedSourceCatalogToolIndexEntry | null, Error>;
};

/** Placeholder — engine's SourceStore service shape */
type SourceStoreShape = {
  loadSourceById: (input: {
    workspaceId: Source["workspaceId"];
    sourceId: Source["id"];
    actorAccountId: AccountId;
  }) => Effect.Effect<Source, Error>;
};

/** Placeholder — engine's WorkspaceConfigStoreShape */
type WorkspaceConfigStoreShape = unknown;

/** Placeholder — engine's Embedder */
type Embedder = {
  dimensions: number;
  [key: string]: unknown;
};

export const createWorkspaceToolInvoker = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: SourceCatalogStoreShape;
  sourceStore: SourceStoreShape;
  sourceCatalog: ToolCatalog;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  sourceAuthMaterialService: SourceAuthMaterialShape;
  sourceAuthService: RuntimeSourceAuthService;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  localToolRuntime: LocalToolRuntime;
  embedder?: Embedder;
  onElicitation?: Parameters<
    typeof makeToolInvokerFromTools
  >[0]["onElicitation"];
}): {
  catalog: ToolCatalog;
  toolInvoker: ToolInvoker;
} => {
  // TODO: createExecutorToolMap, provideRuntimeLocalWorkspace, and
  // workspace service layers are engine internals. These need to be
  // abstracted into port interfaces or moved to control-plane.

  const executorTools: ToolMap = {};
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
    Effect.gen(function* () {
      const catalogTool = yield* input.sourceCatalogStore.loadWorkspaceSourceCatalogToolByPath({
        workspaceId: input.workspaceId,
        path: invocation.path,
        actorAccountId: input.accountId,
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
        auth: auth as { kind: string; [key: string]: unknown },
        args: invocation.args,
        onElicitation: input.onElicitation,
        context: invocation.context,
      });
    });

  return {
    catalog,
    toolInvoker: {
      invoke: ({ path, args, context }) =>
        (authoredToolPaths.has(path)
          ? authoredInvoker.invoke({ path, args, context })
          : invokePersistedTool({ path, args, context })
        ) as Effect.Effect<unknown, unknown, never>,
    },
  };
};
