import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

const createEmbedderMock = vi.fn();
const createWorkspaceToolInvokerMock = vi.fn();
const indexWorkspaceToolsIntoSqliteMock = vi.fn();
const createWorkspaceSourceCatalogMock = vi.fn();
const getRuntimeLocalWorkspaceOptionMock = vi.fn();

vi.mock("../../../db/embedder", () => ({
  createEmbedder: createEmbedderMock,
}));

vi.mock("./tool-invoker", () => ({
  createWorkspaceToolInvoker: createWorkspaceToolInvokerMock,
}));

vi.mock("./source-catalog", () => ({
  indexWorkspaceToolsIntoSqlite: indexWorkspaceToolsIntoSqliteMock,
  createWorkspaceSourceCatalog: createWorkspaceSourceCatalogMock,
}));

vi.mock("../../local/runtime-context", () => ({
  getRuntimeLocalWorkspaceOption: getRuntimeLocalWorkspaceOptionMock,
}));

describe("loadConfiguredSemanticSearchEmbedder", () => {
  beforeEach(async () => {
    createEmbedderMock.mockReset();
    createWorkspaceToolInvokerMock.mockReset();
    indexWorkspaceToolsIntoSqliteMock.mockReset();
    createWorkspaceSourceCatalogMock.mockReset();
    getRuntimeLocalWorkspaceOptionMock.mockReset();
    const environmentModule = await import("./environment");
    environmentModule.clearWorkspaceExecutionCachesForTests();
  });

  it("reuses the same embedder for repeated identical configs", async () => {
    const embed = vi.fn(async () => [1, 2, 3]);
    const embedder = {
      provider: "local",
      model: "test-model",
      dimensions: 384,
      embed,
      embedBatch: async () => [[1, 2, 3]],
    };
    createEmbedderMock.mockResolvedValue(embedder);

    const environmentModule = await import("./environment");
    const config = {
      semanticSearch: {
        provider: "local",
        model: "test-model",
      },
    };

    const first = await Effect.runPromise(
      environmentModule.loadConfiguredSemanticSearchEmbedder(config as never),
    );
    const second = await Effect.runPromise(
      environmentModule.loadConfiguredSemanticSearchEmbedder(config as never),
    );

    expect(first).toBe(embedder);
    expect(second).toBe(embedder);
    expect(createEmbedderMock).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith("__executor_dimension_probe__", "document");
  });

  it("does not probe remote embedders when provider defaults already define dimensions", async () => {
    const embed = vi.fn(async () => [1, 2, 3]);
    const embedder = {
      provider: "google",
      model: "gemini-embedding-2-preview",
      dimensions: 3072,
      embed,
      embedBatch: async () => [[1, 2, 3]],
    };
    createEmbedderMock.mockResolvedValue(embedder);

    const environmentModule = await import("./environment");

    const loaded = await Effect.runPromise(
      environmentModule.loadConfiguredSemanticSearchEmbedder({
        semanticSearch: {
          provider: "google",
          model: "gemini-embedding-2-preview",
        },
      } as never),
    );

    expect(loaded).toBe(embedder);
    expect(embed).not.toHaveBeenCalled();
  });

  it("creates a new embedder when the semantic search config changes", async () => {
    createEmbedderMock
      .mockResolvedValueOnce({
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        embed: async () => [1],
        embedBatch: async () => [[1]],
      })
      .mockResolvedValueOnce({
        provider: "openai",
        model: "text-embedding-3-large",
        dimensions: 3072,
        embed: async () => [2],
        embedBatch: async () => [[2]],
      });

    const environmentModule = await import("./environment");

    await Effect.runPromise(
      environmentModule.loadConfiguredSemanticSearchEmbedder({
        semanticSearch: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      } as never),
    );

    await Effect.runPromise(
      environmentModule.loadConfiguredSemanticSearchEmbedder({
        semanticSearch: {
          provider: "openai",
          model: "text-embedding-3-large",
        },
      } as never),
    );

    expect(createEmbedderMock).toHaveBeenCalledTimes(2);
  });
});

describe("createWorkspaceExecutionEnvironmentResolver", () => {
  beforeEach(async () => {
    createEmbedderMock.mockReset();
    createWorkspaceToolInvokerMock.mockReset();
    indexWorkspaceToolsIntoSqliteMock.mockReset();
    createWorkspaceSourceCatalogMock.mockReset();
    getRuntimeLocalWorkspaceOptionMock.mockReset();
    const environmentModule = await import("./environment");
    environmentModule.clearWorkspaceExecutionCachesForTests();
  });

  it("reuses the SQLite index and source catalog when workspace state is unchanged", async () => {
    const environmentModule = await import("./environment");
    const runtimeLocalWorkspace = {
      context: {
        stateDirectory: "/tmp/executor-tests",
      },
    };
    const sourceCatalog = {
      searchTools: vi.fn(),
      listTools: vi.fn(),
      listNamespaces: vi.fn(),
      getToolByPath: vi.fn(),
    };

    getRuntimeLocalWorkspaceOptionMock.mockReturnValue(Effect.succeed(runtimeLocalWorkspace));
    indexWorkspaceToolsIntoSqliteMock.mockReturnValue(Effect.succeed(true));
    createWorkspaceSourceCatalogMock.mockReturnValue(sourceCatalog);
    createWorkspaceToolInvokerMock.mockImplementation(({ sourceCatalog }: { sourceCatalog: unknown }) => ({
      catalog: sourceCatalog,
      toolInvoker: { invoke: vi.fn() },
    }));

    const resolver = environmentModule.createWorkspaceExecutionEnvironmentResolver({
      sourceAuthMaterialService: {} as never,
      sourceAuthService: {} as never,
      sourceCatalogStore: {} as never,
      localToolRuntimeLoader: {
        load: () =>
          Effect.succeed({
            tools: {},
            catalog: {},
            toolInvoker: {},
            toolPaths: new Set<string>(),
          } as never),
      },
      workspaceConfigStore: {
        load: () => Effect.succeed({ config: null }),
      } as never,
      workspaceStateStore: {
        load: () =>
          Effect.succeed({
            version: 1,
            sources: {
              github: {
                status: "connected",
                lastError: null,
                sourceHash: "hash-1",
                createdAt: 1,
                updatedAt: 2,
              },
            },
            policies: {},
            catalog: {
              semanticSearchSignature: null,
            },
          }),
      } as never,
      sourceArtifactStore: {} as never,
    });

    await Effect.runPromise(
      resolver({
        workspaceId: "workspace-1" as never,
        accountId: "account-1" as never,
      } as never),
    );
    await Effect.runPromise(
      resolver({
        workspaceId: "workspace-1" as never,
        accountId: "account-1" as never,
      } as never),
    );

    expect(indexWorkspaceToolsIntoSqliteMock).toHaveBeenCalledTimes(1);
    expect(createWorkspaceSourceCatalogMock).toHaveBeenCalledTimes(1);
    expect(createWorkspaceToolInvokerMock).toHaveBeenCalledTimes(2);
    expect(createWorkspaceToolInvokerMock.mock.calls[0]?.[0]?.sourceCatalog).toBe(sourceCatalog);
    expect(createWorkspaceToolInvokerMock.mock.calls[1]?.[0]?.sourceCatalog).toBe(sourceCatalog);
  });

  it("rebuilds the SQLite index and source catalog when workspace state changes", async () => {
    const environmentModule = await import("./environment");
    const runtimeLocalWorkspace = {
      context: {
        stateDirectory: "/tmp/executor-tests",
      },
    };

    getRuntimeLocalWorkspaceOptionMock.mockReturnValue(Effect.succeed(runtimeLocalWorkspace));
    indexWorkspaceToolsIntoSqliteMock.mockReturnValue(Effect.succeed(true));
    createWorkspaceSourceCatalogMock
      .mockReturnValueOnce({
        searchTools: vi.fn(),
        listTools: vi.fn(),
        listNamespaces: vi.fn(),
        getToolByPath: vi.fn(),
      })
      .mockReturnValueOnce({
        searchTools: vi.fn(),
        listTools: vi.fn(),
        listNamespaces: vi.fn(),
        getToolByPath: vi.fn(),
      });
    createWorkspaceToolInvokerMock.mockImplementation(({ sourceCatalog }: { sourceCatalog: unknown }) => ({
      catalog: sourceCatalog,
      toolInvoker: { invoke: vi.fn() },
    }));

    const workspaceStates = [
      {
        version: 1,
        sources: {
          github: {
            status: "connected",
            lastError: null,
            sourceHash: "hash-1",
            createdAt: 1,
            updatedAt: 2,
          },
        },
        policies: {},
        catalog: {
          semanticSearchSignature: null,
        },
      },
      {
        version: 1,
        sources: {
          github: {
            status: "connected",
            lastError: null,
            sourceHash: "hash-2",
            createdAt: 1,
            updatedAt: 3,
          },
        },
        policies: {},
        catalog: {
          semanticSearchSignature: null,
        },
      },
    ];

    const resolver = environmentModule.createWorkspaceExecutionEnvironmentResolver({
      sourceAuthMaterialService: {} as never,
      sourceAuthService: {} as never,
      sourceCatalogStore: {} as never,
      localToolRuntimeLoader: {
        load: () =>
          Effect.succeed({
            tools: {},
            catalog: {},
            toolInvoker: {},
            toolPaths: new Set<string>(),
          } as never),
      },
      workspaceConfigStore: {
        load: () => Effect.succeed({ config: null }),
      } as never,
      workspaceStateStore: {
        load: vi.fn(() => Effect.succeed(workspaceStates.shift()!)),
      } as never,
      sourceArtifactStore: {} as never,
    });

    await Effect.runPromise(
      resolver({
        workspaceId: "workspace-1" as never,
        accountId: "account-1" as never,
      } as never),
    );
    await Effect.runPromise(
      resolver({
        workspaceId: "workspace-1" as never,
        accountId: "account-1" as never,
      } as never),
    );

    expect(indexWorkspaceToolsIntoSqliteMock).toHaveBeenCalledTimes(2);
    expect(createWorkspaceSourceCatalogMock).toHaveBeenCalledTimes(2);
  });

  it("retries SQLite indexing after a cached failure for the same workspace signature", async () => {
    const environmentModule = await import("./environment");
    const runtimeLocalWorkspace = {
      context: {
        stateDirectory: "/tmp/executor-tests",
      },
    };

    getRuntimeLocalWorkspaceOptionMock.mockReturnValue(Effect.succeed(runtimeLocalWorkspace));
    indexWorkspaceToolsIntoSqliteMock
      .mockReturnValueOnce(Effect.succeed(false))
      .mockReturnValueOnce(Effect.succeed(true));
    createWorkspaceSourceCatalogMock
      .mockReturnValueOnce({
        searchTools: vi.fn(),
        listTools: vi.fn(),
        listNamespaces: vi.fn(),
        getToolByPath: vi.fn(),
      })
      .mockReturnValueOnce({
        searchTools: vi.fn(),
        listTools: vi.fn(),
        listNamespaces: vi.fn(),
        getToolByPath: vi.fn(),
      });
    createWorkspaceToolInvokerMock.mockImplementation(({ sourceCatalog }: { sourceCatalog: unknown }) => ({
      catalog: sourceCatalog,
      toolInvoker: { invoke: vi.fn() },
    }));

    const workspaceState = {
      version: 1,
      sources: {
        github: {
          status: "connected",
          lastError: null,
          sourceHash: "hash-1",
          createdAt: 1,
          updatedAt: 2,
        },
      },
      policies: {},
      catalog: {
        semanticSearchSignature: null,
      },
    };

    const resolver = environmentModule.createWorkspaceExecutionEnvironmentResolver({
      sourceAuthMaterialService: {} as never,
      sourceAuthService: {} as never,
      sourceCatalogStore: {} as never,
      localToolRuntimeLoader: {
        load: () =>
          Effect.succeed({
            tools: {},
            catalog: {},
            toolInvoker: {},
            toolPaths: new Set<string>(),
          } as never),
      },
      workspaceConfigStore: {
        load: () => Effect.succeed({ config: null }),
      } as never,
      workspaceStateStore: {
        load: () => Effect.succeed(workspaceState),
      } as never,
      sourceArtifactStore: {} as never,
    });

    await Effect.runPromise(
      resolver({
        workspaceId: "workspace-1" as never,
        accountId: "account-1" as never,
      } as never),
    );
    await Effect.runPromise(
      resolver({
        workspaceId: "workspace-1" as never,
        accountId: "account-1" as never,
      } as never),
    );

    expect(indexWorkspaceToolsIntoSqliteMock).toHaveBeenCalledTimes(2);
    expect(createWorkspaceSourceCatalogMock).toHaveBeenCalledTimes(2);
  });
});
