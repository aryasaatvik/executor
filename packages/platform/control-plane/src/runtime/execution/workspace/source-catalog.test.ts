import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

vi.mock("../../../db/catalog", () => ({
  createSqliteToolCatalog: vi.fn(),
}));

vi.mock("../../../db/setup", () => ({
  makeWorkspaceCatalogDbLayer: vi.fn(() => ({})),
}));

import { createWorkspaceSourceCatalog } from "./source-catalog";
import type { LoadedSourceCatalogToolIndexEntry } from "../../catalog/source/runtime";

const makeTool = (input: {
  path: string;
  sourceKey: string;
  namespace: string;
  description?: string;
}): LoadedSourceCatalogToolIndexEntry =>
  ({
    path: input.path,
    searchNamespace: input.namespace,
    searchText: `${input.path} ${input.description ?? ""}`.trim(),
    descriptor: {
      path: input.path,
      sourceKey: input.sourceKey,
      ...(input.description ? { description: input.description } : {}),
    },
    source: {
      id: `${input.sourceKey}-id`,
      namespace: input.sourceKey,
      enabled: true,
      status: "connected",
    },
    capability: { surface: {} },
  }) as LoadedSourceCatalogToolIndexEntry;

describe("createWorkspaceSourceCatalog", () => {
  it("falls back to the JSON-backed catalog when SQLite indexing is unavailable", async () => {
    const jsonTool = makeTool({
      path: "github.issues.create",
      sourceKey: "github",
      namespace: "github.issues",
      description: "Create a GitHub issue",
    });

    const catalog = createWorkspaceSourceCatalog({
      workspaceId: "workspace-1" as never,
      accountId: "account-1" as never,
      sourceCatalogStore: {
        loadWorkspaceSourceCatalogToolIndex: () => Effect.succeed([jsonTool]),
        loadWorkspaceSourceCatalogToolByPath: ({ path }: { path: string }) =>
          Effect.succeed(path === jsonTool.path ? jsonTool : null),
      } as never,
      workspaceConfigStore: {} as never,
      workspaceStateStore: {} as never,
      sourceArtifactStore: {} as never,
      runtimeLocalWorkspace: {
        context: {
          stateDirectory: "/tmp/executor-tests",
        },
      } as never,
      sqliteCatalogReady: false,
    });

    const tools = await Effect.runPromise(
      catalog.listTools({ limit: 10, includeSchemas: false }),
    );
    const searched = await Effect.runPromise(
      catalog.searchTools({
        query: "create github issue",
        sourceKey: "github",
        limit: 10,
      }),
    );
    const byPath = await Effect.runPromise(
      catalog.getToolByPath({
        path: jsonTool.path as never,
        includeSchemas: false,
      }),
    );

    expect(tools.map((tool) => tool.path)).toEqual([jsonTool.path]);
    expect(searched.map((hit) => hit.path)).toEqual([jsonTool.path]);
    expect(byPath?.path).toBe(jsonTool.path);
  });
});
