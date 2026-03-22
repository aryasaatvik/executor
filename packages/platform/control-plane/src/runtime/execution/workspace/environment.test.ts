import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

const createEmbedderMock = vi.fn();
const createWorkspaceToolInvokerMock = vi.fn();
const indexWorkspaceToolsIntoSqliteMock = vi.fn();
const createWorkspaceSourceCatalogMock = vi.fn();
const getRuntimeLocalWorkspaceOptionMock = vi.fn();
const resolveSecretMaterialMock = vi.fn();

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
    resolveSecretMaterialMock.mockReset();
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
      environmentModule.loadConfiguredSemanticSearchEmbedder(
        resolveSecretMaterialMock as never,
        config as never,
      ),
    );
    const second = await Effect.runPromise(
      environmentModule.loadConfiguredSemanticSearchEmbedder(
        resolveSecretMaterialMock as never,
        config as never,
      ),
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
    resolveSecretMaterialMock.mockReturnValue(Effect.succeed("google-api-key"));

    const environmentModule = await import("./environment");

    const loaded = await Effect.runPromise(
      environmentModule.loadConfiguredSemanticSearchEmbedder(resolveSecretMaterialMock as never, {
        semanticSearch: {
          provider: "google",
          model: "gemini-embedding-2-preview",
          apiKeyRef: {
            providerId: "local",
            handle: "secret_google",
          },
        },
      } as never),
    );

    expect(loaded).toBe(embedder);
    expect(embed).not.toHaveBeenCalled();
    expect(resolveSecretMaterialMock).toHaveBeenCalledWith({
      ref: {
        providerId: "local",
        handle: "secret_google",
      },
    });
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
    resolveSecretMaterialMock
      .mockReturnValueOnce(Effect.succeed("openai-key-small"))
      .mockReturnValueOnce(Effect.succeed("openai-key-large"));

    const environmentModule = await import("./environment");

    await Effect.runPromise(
      environmentModule.loadConfiguredSemanticSearchEmbedder(resolveSecretMaterialMock as never, {
        semanticSearch: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKeyRef: {
            providerId: "local",
            handle: "secret_small",
          },
        },
      } as never),
    );

    await Effect.runPromise(
      environmentModule.loadConfiguredSemanticSearchEmbedder(resolveSecretMaterialMock as never, {
        semanticSearch: {
          provider: "openai",
          model: "text-embedding-3-large",
          apiKeyRef: {
            providerId: "local",
            handle: "secret_large",
          },
        },
      } as never),
    );

    expect(createEmbedderMock).toHaveBeenCalledTimes(2);
  });

  it("fails when semantic search is configured and embedder initialization errors", async () => {
    createEmbedderMock.mockRejectedValue(new Error("missing provider package"));
    resolveSecretMaterialMock.mockReturnValue(Effect.succeed("openai-key"));

    const environmentModule = await import("./environment");

    await expect(
      Effect.runPromise(
        environmentModule.loadConfiguredSemanticSearchEmbedder(resolveSecretMaterialMock as never, {
          semanticSearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            apiKeyRef: {
              providerId: "local",
              handle: "secret_openai",
            },
          },
        } as never),
      ),
    ).rejects.toThrow("missing provider package");
  });
});

describe("createWorkspaceExecutionEnvironmentResolver", () => {
  beforeEach(async () => {
    createEmbedderMock.mockReset();
    createWorkspaceToolInvokerMock.mockReset();
    indexWorkspaceToolsIntoSqliteMock.mockReset();
    createWorkspaceSourceCatalogMock.mockReset();
    getRuntimeLocalWorkspaceOptionMock.mockReset();
    resolveSecretMaterialMock.mockReset();
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
    indexWorkspaceToolsIntoSqliteMock.mockReturnValue(Effect.void);
    createWorkspaceSourceCatalogMock.mockReturnValue(sourceCatalog);
    createWorkspaceToolInvokerMock.mockImplementation(({ sourceCatalog }: { sourceCatalog: unknown }) => ({
      catalog: sourceCatalog,
      toolInvoker: { invoke: vi.fn() },
    }));

    const resolver = environmentModule.createWorkspaceExecutionEnvironmentResolver({
      resolveSecretMaterial: resolveSecretMaterialMock as never,
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
    indexWorkspaceToolsIntoSqliteMock.mockReturnValue(Effect.void);
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
      resolveSecretMaterial: resolveSecretMaterialMock as never,
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

  it("retries SQLite indexing after a failure for the same workspace signature", async () => {
    const environmentModule = await import("./environment");
    const runtimeLocalWorkspace = {
      context: {
        stateDirectory: "/tmp/executor-tests",
      },
    };

    getRuntimeLocalWorkspaceOptionMock.mockReturnValue(Effect.succeed(runtimeLocalWorkspace));
    indexWorkspaceToolsIntoSqliteMock
      .mockReturnValueOnce(Effect.fail(new Error("sqlite unavailable")))
      .mockReturnValueOnce(Effect.void);
    createWorkspaceSourceCatalogMock.mockReturnValue({
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
      resolveSecretMaterial: resolveSecretMaterialMock as never,
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

    await expect(
      Effect.runPromise(
        resolver({
          workspaceId: "workspace-1" as never,
          accountId: "account-1" as never,
        } as never),
      ),
    ).rejects.toThrow("sqlite unavailable");
    await Effect.runPromise(
      resolver({
        workspaceId: "workspace-1" as never,
        accountId: "account-1" as never,
      } as never),
    );

    expect(indexWorkspaceToolsIntoSqliteMock).toHaveBeenCalledTimes(2);
    expect(createWorkspaceSourceCatalogMock).toHaveBeenCalledTimes(1);
  });
});
