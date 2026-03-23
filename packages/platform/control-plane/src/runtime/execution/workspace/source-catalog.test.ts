import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { SourceIdSchema, WorkspaceIdSchema } from "#schema";
import { SqliteToolCatalogService } from "../../../db/catalog";

vi.mock("../../../db/setup", () => ({
  makeWorkspaceCatalogDbLayer: () => Layer.empty,
  makeWorkspaceCatalogQueryDbLayer: () => Layer.empty,
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
      id: SourceIdSchema.make(`${input.sourceKey}-id`),
      workspaceId: WorkspaceIdSchema.make("workspace-1"),
      name: input.sourceKey,
      kind: "mcp",
      endpoint: `https://${input.sourceKey}.example.com`,
      namespace: input.sourceKey,
      enabled: true,
      status: "connected",
      createdAt: 1,
      updatedAt: 2,
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

  it("fails when no local workspace is active", async () => {
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

    await expect(
      Effect.runPromise(catalog.listTools({ limit: 10, includeSchemas: false })),
    ).rejects.toThrow("Runtime local workspace is required for the SQLite source catalog.");
  });

  it("surfaces SQLite catalog failures instead of falling back", async () => {
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
      dependencies: {
        makeSqliteToolCatalogLive: () =>
          Layer.effect(
            SqliteToolCatalogService,
            Effect.fail(new Error("sqlite unavailable")) as never,
          ),
        makeWorkspaceCatalogDbLayer: () => Layer.empty,
        makeWorkspaceCatalogQueryDbLayer: () => Layer.empty,
      },
    });

    await expect(
      Effect.runPromise(catalog.listTools({ limit: 10, includeSchemas: false })),
    ).rejects.toThrow("sqlite unavailable");
  });

  it("opens and releases a scoped SQLite catalog for each method call", async () => {
    let acquisitions = 0;
    let releases = 0;

    const createScopedCatalog = () =>
      Effect.ensuring(
        Effect.sync(() => {
          acquisitions += 1;
          return {
            searchTools: () =>
              Effect.succeed([{ path: "github.issues.create", score: 1 }] as const),
            listTools: () =>
              Effect.succeed([
                {
                  path: "github.issues.create",
                  sourceKey: "github",
                  interaction: "auto",
                },
              ] as const),
            listNamespaces: () =>
              Effect.succeed([{ namespace: "github.issues", toolCount: 1 }] as const),
            getToolByPath: () =>
              Effect.succeed({
                path: "github.issues.create",
                sourceKey: "github",
                interaction: "auto",
              } as const),
          };
        }),
        Effect.sync(() => {
          releases += 1;
        }),
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
      dependencies: {
        makeSqliteToolCatalogLive: () =>
          Layer.scoped(SqliteToolCatalogService, createScopedCatalog() as never),
        makeWorkspaceCatalogDbLayer: () => Layer.empty,
        makeWorkspaceCatalogQueryDbLayer: () => Layer.empty,
      },
    });

    await Effect.runPromise(catalog.listTools({ limit: 10, includeSchemas: false }));
    await Effect.runPromise(catalog.searchTools({ query: "create", limit: 10 }));
    await Effect.runPromise(catalog.listNamespaces({ limit: 10 }));
    await Effect.runPromise(
      catalog.getToolByPath({ path: "github.issues.create" as never, includeSchemas: false }),
    );

    expect(acquisitions).toBe(4);
    expect(releases).toBe(4);
  });

  it("re-embeds all tools when the semantic-search signature changes", async () => {
    const indexSourceMock = vi.fn(() => Effect.succeed({ changedTools: [] }));
    const embedSourceToolsMock = vi.fn(() => Effect.void);
    const write = vi.fn(() => Effect.void);
    const tools = [
      makeTool({
        path: "github.issues.create",
        sourceKey: "src_123",
        namespace: "github.issues",
      }),
    ];
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
        dependencies: {
          makeWorkspaceCatalogDbLayer: () => Layer.succeed(SqliteDrizzle, fakeDb as never),
          indexSource: indexSourceMock as never,
          embedSourceTools: embedSourceToolsMock as never,
        },
      }),
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
    const indexSourceMock = vi.fn(() => Effect.succeed({ changedTools: [] }));
    const embedSourceToolsMock = vi.fn(() => Effect.void);
    const syncSourceLifecycleMock = vi.fn(() => Effect.void);
    const removeSourceToolsMock = vi.fn(() => Effect.void);
    const removeSourceEmbeddingsMock = vi.fn(() => Effect.void);

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
        dependencies: {
          makeWorkspaceCatalogDbLayer: () => Layer.succeed(SqliteDrizzle, fakeDb as never),
          indexSource: indexSourceMock as never,
          embedSourceTools: embedSourceToolsMock as never,
          syncSourceLifecycle: syncSourceLifecycleMock as never,
          removeSourceTools: removeSourceToolsMock as never,
          removeSourceEmbeddings: removeSourceEmbeddingsMock as never,
        },
      }),
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
