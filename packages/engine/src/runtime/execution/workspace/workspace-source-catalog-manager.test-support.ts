import type { ToolCatalog } from "@executor/codemode-core";
import * as Effect from "effect/Effect";

import type { makeWorkspaceSourceCatalogManager } from "./environment";
import type { ManagedWorkspaceSourceCatalog } from "./source-catalog";

type WorkspaceSourceCatalogManager =
  Effect.Effect.Success<ReturnType<typeof makeWorkspaceSourceCatalogManager>>;

type WorkspaceSourceCatalogManagerInput = Parameters<
  WorkspaceSourceCatalogManager["getOrRefresh"]
>[0];

type WorkspaceSourceCatalogManagerTestCalls = {
  getOrRefresh: WorkspaceSourceCatalogManagerInput[];
  clear: number;
  close: number;
};

const makeWorkspaceSourceCatalogTestCatalog = (): ToolCatalog => ({
  searchTools: () => Effect.succeed([]),
  listTools: () => Effect.succeed([]),
  listNamespaces: () => Effect.succeed([]),
  getToolByPath: () => Effect.succeed(null),
});

const makeManagedWorkspaceSourceCatalogTest = (input: {
  calls: WorkspaceSourceCatalogManagerTestCalls;
  catalog?: ToolCatalog;
}): ManagedWorkspaceSourceCatalog => ({
  catalog: input.catalog ?? makeWorkspaceSourceCatalogTestCatalog(),
  close: Effect.sync(() => {
    input.calls.close += 1;
  }),
});

export const makeWorkspaceSourceCatalogManagerTestHandle = (input: {
  managedSourceCatalog?: ManagedWorkspaceSourceCatalog;
  catalog?: ToolCatalog;
  getOrRefresh?: (
    input: WorkspaceSourceCatalogManagerInput,
  ) => Effect.Effect<ManagedWorkspaceSourceCatalog, unknown, never>;
} = {}) => {
  const calls: WorkspaceSourceCatalogManagerTestCalls = {
    getOrRefresh: [],
    clear: 0,
    close: 0,
  };
  const managedSourceCatalog =
    input.managedSourceCatalog
    ?? makeManagedWorkspaceSourceCatalogTest({
      calls,
      catalog: input.catalog,
    });
  const workspaceSourceCatalogManager: WorkspaceSourceCatalogManager = {
    getOrRefresh: (managerInput) => {
      calls.getOrRefresh.push(managerInput);
      return input.getOrRefresh
        ? input.getOrRefresh(managerInput)
        : Effect.succeed(managedSourceCatalog);
    },
    clear: Effect.sync(() => {
      calls.clear += 1;
      calls.close += 1;
    }),
  };

  return {
    workspaceSourceCatalogManager,
    managedSourceCatalog,
    calls,
  };
};
