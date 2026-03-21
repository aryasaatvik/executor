import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";

const {
  indexSourceMock,
  embedSourceToolsMock,
} = vi.hoisted(() => ({
  indexSourceMock: vi.fn(),
  embedSourceToolsMock: vi.fn(),
}));

vi.mock("../../../db/catalog", () => ({
  createSqliteToolCatalog: vi.fn(),
}));

vi.mock("../../../db/setup", () => ({
  makeWorkspaceCatalogDbLayer: vi.fn(() => Layer.empty),
}));

vi.mock("../../../db/indexer", () => ({
  indexSource: indexSourceMock,
  deactivateSourceTools: vi.fn(),
  removeSourceTools: vi.fn(() => Effect.void),
}));

vi.mock("../../../db/embed-indexer", () => ({
  embedSourceTools: embedSourceToolsMock,
  removeSourceEmbeddings: vi.fn(() => Effect.void),
}));

import {
  createWorkspaceSourceCatalog,
  indexWorkspaceToolsIntoSqlite,
  toToolToIndex,
} from "./source-catalog";
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
  it("indexes tools with the canonical descriptor sourceKey", () => {
    const tool = makeTool({
      path: "github.issues.create",
      sourceKey: "src_123",
      namespace: "github.issues",
      description: "Create a GitHub issue",
    });
    tool.source.namespace = "github";

    expect(toToolToIndex(tool).sourceKey).toBe("src_123");
  });

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

  it("re-embeds all tools when the semantic-search signature changes", async () => {
    indexSourceMock.mockReset();
    embedSourceToolsMock.mockReset();
    indexSourceMock.mockReturnValue(Effect.succeed({ changedTools: [] }));
    embedSourceToolsMock.mockReturnValue(Effect.void);

    const tools = [
      makeTool({
        path: "github.issues.create",
        sourceKey: "src_123",
        namespace: "github.issues",
      }),
    ];
    const write = vi.fn(() => Effect.void);
    const fakeDb = {
      selectDistinct: () => ({
        from: () => Effect.succeed([]),
      }),
    };

    const result = await Effect.runPromise(
      indexWorkspaceToolsIntoSqlite({
        workspaceId: "workspace-1" as never,
        accountId: "account-1" as never,
        sourceCatalogStore: {
          loadWorkspaceSourceCatalogToolIndex: () => Effect.succeed(tools),
        } as never,
        workspaceConfigStore: {} as never,
        workspaceStateStore: {
          load: () =>
            Effect.succeed({
              version: 1,
              sources: {},
              policies: {},
              catalog: {
                semanticSearchSignature: "old-signature",
              },
            }),
          write,
        } as never,
        sourceArtifactStore: {} as never,
        runtimeLocalWorkspace: {
          context: {
            stateDirectory: "/tmp/executor-tests",
          },
        } as never,
        embedder: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 1536,
          embed: async () => [1, 2, 3],
          embedBatch: async () => [[1, 2, 3]],
        },
      }).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, fakeDb as never)),
      ),
    );

    expect(result).toBe(true);
    expect(indexSourceMock).toHaveBeenCalledTimes(1);
    expect(embedSourceToolsMock).toHaveBeenCalledTimes(1);
    expect(embedSourceToolsMock.mock.calls[0]?.[0]?.tools).toHaveLength(1);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]?.state.catalog.semanticSearchSignature).toBe(
      JSON.stringify({
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      }),
    );
  });
});
