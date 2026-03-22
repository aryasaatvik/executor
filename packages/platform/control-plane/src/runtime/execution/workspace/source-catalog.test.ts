import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { createSqliteToolCatalog } from "../../../db/catalog";

const {
  indexSourceMock,
  embedSourceToolsMock,
  removeSourceToolsMock,
  removeSourceEmbeddingsMock,
  syncSourceLifecycleMock,
} = vi.hoisted(() => ({
  indexSourceMock: vi.fn(),
  embedSourceToolsMock: vi.fn(),
  removeSourceToolsMock: vi.fn(),
  removeSourceEmbeddingsMock: vi.fn(),
  syncSourceLifecycleMock: vi.fn(),
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
  removeSourceTools: removeSourceToolsMock,
  syncSourceLifecycle: syncSourceLifecycleMock,
}));

vi.mock("../../../db/embed-indexer", () => ({
  embedSourceTools: embedSourceToolsMock,
  removeSourceEmbeddings: removeSourceEmbeddingsMock,
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
  beforeEach(() => {
    vi.mocked(createSqliteToolCatalog).mockReset();
    indexSourceMock.mockReset();
    embedSourceToolsMock.mockReset();
    removeSourceToolsMock.mockReset();
    removeSourceEmbeddingsMock.mockReset();
    syncSourceLifecycleMock.mockReset();
    removeSourceToolsMock.mockReturnValue(Effect.void);
    removeSourceEmbeddingsMock.mockReturnValue(Effect.void);
    syncSourceLifecycleMock.mockReturnValue(Effect.void);
  });

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

  it("returns an empty catalog when no local workspace is active", async () => {
    const catalog = createWorkspaceSourceCatalog({
      workspaceId: "workspace-1" as never,
      accountId: "account-1" as never,
      sourceCatalogStore: {
        loadWorkspaceSourceCatalogToolIndex: () => Effect.succeed([]),
        loadWorkspaceSourceCatalogToolByPath: () => Effect.succeed(null),
      } as never,
      workspaceConfigStore: {} as never,
      workspaceStateStore: {} as never,
      sourceArtifactStore: {} as never,
      runtimeLocalWorkspace: null,
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
        path: "github.issues.create" as never,
        includeSchemas: false,
      }),
    );

    expect(tools).toEqual([]);
    expect(searched).toEqual([]);
    expect(byPath).toBeNull();
  });

  it("surfaces SQLite catalog failures instead of falling back", async () => {
    vi.mocked(createSqliteToolCatalog).mockReset();
    vi.mocked(createSqliteToolCatalog).mockReturnValue(
      Effect.fail(new Error("sqlite unavailable")) as never,
    );

    const catalog = createWorkspaceSourceCatalog({
      workspaceId: "workspace-1" as never,
      accountId: "account-1" as never,
      sourceCatalogStore: {
        loadWorkspaceSourceCatalogToolIndex: () => Effect.succeed([]),
        loadWorkspaceSourceCatalogToolByPath: () => Effect.succeed(null),
      } as never,
      workspaceConfigStore: {} as never,
      workspaceStateStore: {} as never,
      sourceArtifactStore: {} as never,
      runtimeLocalWorkspace: {
        context: {
          stateDirectory: "/tmp/executor-tests",
        },
      } as never,
    });

    await expect(
      Effect.runPromise(catalog.listTools({ limit: 10, includeSchemas: false })),
    ).rejects.toThrow("sqlite unavailable");
  });

  it("reuses the SQLite catalog across method calls", async () => {
    vi.mocked(createSqliteToolCatalog).mockReset();

    let executions = 0;
    vi.mocked(createSqliteToolCatalog).mockReturnValue(
      Effect.sync(() => {
        executions += 1;
        return {
          searchTools: () =>
            Effect.succeed([
              { path: "github.issues.create", score: 1 },
            ] as const),
          listTools: () =>
            Effect.succeed([
              {
                path: "github.issues.create",
                sourceKey: "github",
                interaction: "auto",
              },
            ] as const),
          listNamespaces: () =>
            Effect.succeed([
              { namespace: "github.issues", toolCount: 1 },
            ] as const),
          getToolByPath: () =>
            Effect.succeed({
              path: "github.issues.create",
              sourceKey: "github",
              interaction: "auto",
            } as const),
        };
      }) as never,
    );

    const catalog = createWorkspaceSourceCatalog({
      workspaceId: "workspace-1" as never,
      accountId: "account-1" as never,
      sourceCatalogStore: {
        loadWorkspaceSourceCatalogToolIndex: () => Effect.succeed([]),
        loadWorkspaceSourceCatalogToolByPath: () => Effect.succeed(null),
      } as never,
      workspaceConfigStore: {} as never,
      workspaceStateStore: {} as never,
      sourceArtifactStore: {} as never,
      runtimeLocalWorkspace: {
        context: {
          stateDirectory: "/tmp/executor-tests",
        },
      } as never,
    });

    await Effect.runPromise(catalog.listTools({ limit: 10, includeSchemas: false }));
    await Effect.runPromise(catalog.searchTools({ query: "create", limit: 10 }));
    await Effect.runPromise(catalog.listNamespaces({ limit: 10 }));

    expect(executions).toBe(1);
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

    expect(result).toBeUndefined();
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

  it("keeps disconnected sources indexed instead of purging them", async () => {
    indexSourceMock.mockReset();
    embedSourceToolsMock.mockReset();
    syncSourceLifecycleMock.mockReset();
    removeSourceToolsMock.mockReset();
    removeSourceEmbeddingsMock.mockReset();
    indexSourceMock.mockReturnValue(Effect.succeed({ changedTools: [] }));
    embedSourceToolsMock.mockReturnValue(Effect.void);
    syncSourceLifecycleMock.mockReturnValue(Effect.void);
    removeSourceToolsMock.mockReturnValue(Effect.void);
    removeSourceEmbeddingsMock.mockReturnValue(Effect.void);

    const connectedTool = makeTool({
      path: "github.issues.create",
      sourceKey: "src_connected",
      namespace: "github.issues",
    });
    const disconnectedTool = makeTool({
      path: "slack.messages.send",
      sourceKey: "src_disconnected",
      namespace: "slack.messages",
    });
    disconnectedTool.source.enabled = true;
    disconnectedTool.source.status = "error";

    const fakeDb = {
      selectDistinct: () => ({
        from: () =>
          Effect.succeed([
            {
              sourceId: connectedTool.source.id,
              sourceKey: connectedTool.descriptor.sourceKey,
            },
            {
              sourceId: disconnectedTool.source.id,
              sourceKey: disconnectedTool.descriptor.sourceKey,
            },
          ]),
      }),
    };

    await Effect.runPromise(
      indexWorkspaceToolsIntoSqlite({
        workspaceId: "workspace-1" as never,
        accountId: "account-1" as never,
        sourceCatalogStore: {
          loadWorkspaceSourceCatalogToolIndex: () =>
            Effect.succeed([connectedTool, disconnectedTool]),
        } as never,
        workspaceConfigStore: {} as never,
        workspaceStateStore: {
          load: () =>
            Effect.succeed({
              version: 1,
              sources: {},
              policies: {},
              catalog: {
                semanticSearchSignature: null,
              },
            }),
          write: vi.fn(() => Effect.void),
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

    expect(removeSourceToolsMock).not.toHaveBeenCalledWith(disconnectedTool.source.id);
    expect(removeSourceEmbeddingsMock).not.toHaveBeenCalledWith(
      disconnectedTool.descriptor.sourceKey,
    );
    expect(indexSourceMock).toHaveBeenCalledTimes(1);
    expect(indexSourceMock.mock.calls[0]?.[0]?.sourceId).toBe(connectedTool.source.id);
    expect(syncSourceLifecycleMock).toHaveBeenCalledTimes(1);
    expect(syncSourceLifecycleMock.mock.calls[0]?.[0]?.sourceId).toBe(
      disconnectedTool.source.id,
    );
    expect(embedSourceToolsMock).toHaveBeenCalledTimes(1);
  });
});
