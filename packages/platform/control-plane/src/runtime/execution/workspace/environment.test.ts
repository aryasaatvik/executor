import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

vi.mock("../../../db/setup", () => ({
  makeWorkspaceCatalogDbLayer: () => Layer.empty,
  makeWorkspaceCatalogQueryDbLayer: () => Layer.empty,
}));

import {
  clearWorkspaceExecutionCachesForTests,
  createWorkspaceExecutionEnvironmentResolver,
  loadConfiguredSemanticSearchEmbedder,
} from "./environment";
import {
  makeWorkspaceSourceCatalogManagerTestHandle,
} from "./workspace-source-catalog-manager.test-support";

const resolveSecretMaterialMock = vi.fn();

const makeWorkspaceToolInvokerFake = (sourceCatalog: unknown) => ({
  catalog: sourceCatalog,
  toolInvoker: {
    invoke: vi.fn(() => Effect.succeed(undefined)),
  },
});

const makeResolverInput = (input?: {
  workspaceConfigStore?: unknown;
  workspaceStateStore?: unknown;
  localToolRuntimeLoader?: unknown;
  dependencies?: Record<string, unknown>;
}) => {
  const localToolRuntimeLoader =
    input?.localToolRuntimeLoader ?? {
      load: () =>
        Effect.succeed({
          tools: {},
          catalog: {},
          toolInvoker: {},
          toolPaths: new Set<string>(),
        } as never),
    };
  const workspaceConfigStore =
    input?.workspaceConfigStore ?? {
      load: () => Effect.succeed({ config: null }),
    };
  const workspaceStateStore =
    input?.workspaceStateStore ?? {
      load: () =>
        Effect.succeed({
          version: 1,
          sources: {},
          catalog: {
            semanticSearchSignature: null,
          },
        }),
    };

  return createWorkspaceExecutionEnvironmentResolver({
    resolveSecretMaterial: resolveSecretMaterialMock as never,
    sourceAuthMaterialService: {} as never,
    sourceAuthService: {} as never,
    sourceCatalogStore: {} as never,
    localToolRuntimeLoader: localToolRuntimeLoader as never,
    workspaceConfigStore: workspaceConfigStore as never,
    workspaceStateStore: workspaceStateStore as never,
    sourceArtifactStore: {} as never,
    dependencies: input?.dependencies as never,
  });
};

describe("loadConfiguredSemanticSearchEmbedder", () => {
  beforeEach(() => {
    resolveSecretMaterialMock.mockReset();
    clearWorkspaceExecutionCachesForTests();
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
    const createEmbedderMock = vi.fn(async () => embedder);
    const config = {
      semanticSearch: {
        provider: "local",
        model: "test-model",
      },
    };

    const first = await Effect.runPromise(
      loadConfiguredSemanticSearchEmbedder(
        resolveSecretMaterialMock as never,
        config as never,
        { createEmbedder: createEmbedderMock as never },
      ),
    );
    const second = await Effect.runPromise(
      loadConfiguredSemanticSearchEmbedder(
        resolveSecretMaterialMock as never,
        config as never,
        { createEmbedder: createEmbedderMock as never },
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
    const createEmbedderMock = vi.fn(async () => embedder);
    resolveSecretMaterialMock.mockReturnValue(Effect.succeed("google-api-key"));

    const loaded = await Effect.runPromise(
      loadConfiguredSemanticSearchEmbedder(resolveSecretMaterialMock as never, {
        semanticSearch: {
          provider: "google",
          model: "gemini-embedding-2-preview",
          apiKeyRef: {
            providerId: "local",
            handle: "secret_google",
          },
        },
      } as never, {
        createEmbedder: createEmbedderMock as never,
      }),
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
    const createEmbedderMock = vi
      .fn()
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

    await Effect.runPromise(
      loadConfiguredSemanticSearchEmbedder(resolveSecretMaterialMock as never, {
        semanticSearch: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKeyRef: {
            providerId: "local",
            handle: "secret_small",
          },
        },
      } as never, {
        createEmbedder: createEmbedderMock as never,
      }),
    );

    await Effect.runPromise(
      loadConfiguredSemanticSearchEmbedder(resolveSecretMaterialMock as never, {
        semanticSearch: {
          provider: "openai",
          model: "text-embedding-3-large",
          apiKeyRef: {
            providerId: "local",
            handle: "secret_large",
          },
        },
      } as never, {
        createEmbedder: createEmbedderMock as never,
      }),
    );

    expect(createEmbedderMock).toHaveBeenCalledTimes(2);
  });

  it("fails when semantic search is configured and embedder initialization errors", async () => {
    const createEmbedderMock = vi.fn(async () => {
      throw new Error("missing provider package");
    });
    resolveSecretMaterialMock.mockReturnValue(Effect.succeed("openai-key"));

    await expect(
      Effect.runPromise(
        loadConfiguredSemanticSearchEmbedder(resolveSecretMaterialMock as never, {
          semanticSearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            apiKeyRef: {
              providerId: "local",
              handle: "secret_openai",
            },
          },
        } as never, {
          createEmbedder: createEmbedderMock as never,
        }),
      ),
    ).rejects.toThrow("missing provider package");
  });
});

describe("createWorkspaceExecutionEnvironmentResolver", () => {
  beforeEach(() => {
    resolveSecretMaterialMock.mockReset();
    clearWorkspaceExecutionCachesForTests();
  });

  it("fails when no runtime local workspace is available", async () => {
    const resolver = makeResolverInput({
      dependencies: {
        getRuntimeLocalWorkspaceOption: () => Effect.succeed(null),
      },
    });

    await expect(
      Effect.runPromise(
        resolver({
          workspaceId: "workspace-1" as never,
          accountId: "account-1" as never,
        } as never),
      ),
    ).rejects.toThrow(
      "Runtime local workspace is required for execution environment resolution.",
    );
  });

  it("reuses the SQLite index and source catalog when workspace state is unchanged", async () => {
    const runtimeLocalWorkspace = {
      context: {
        stateDirectory: "/tmp/executor-tests",
      },
    };
    const sourceCatalogTest = makeWorkspaceSourceCatalogManagerTestHandle();
    const createWorkspaceToolInvokerMock = vi.fn(({ sourceCatalog }: { sourceCatalog: unknown }) =>
      makeWorkspaceToolInvokerFake(sourceCatalog),
    );

    const resolver = makeResolverInput({
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
            catalog: {
              semanticSearchSignature: null,
            },
          }),
      },
      dependencies: {
        getRuntimeLocalWorkspaceOption: () => Effect.succeed(runtimeLocalWorkspace),
        loadConfiguredSemanticSearchEmbedder: () => Effect.succeed(undefined),
        workspaceSourceCatalogManager:
          sourceCatalogTest.workspaceSourceCatalogManager as never,
        createWorkspaceToolInvoker: createWorkspaceToolInvokerMock,
      },
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

    expect(sourceCatalogTest.calls.getOrRefresh).toHaveLength(2);
    expect(createWorkspaceToolInvokerMock).toHaveBeenCalledTimes(2);
    expect(createWorkspaceToolInvokerMock.mock.calls[0]?.[0]?.sourceCatalog).toBe(
      sourceCatalogTest.managedSourceCatalog.catalog,
    );
    expect(createWorkspaceToolInvokerMock.mock.calls[1]?.[0]?.sourceCatalog).toBe(
      sourceCatalogTest.managedSourceCatalog.catalog,
    );
    expect(sourceCatalogTest.calls.close).toBe(0);
  });

  it("rebuilds the SQLite index and source catalog when workspace state changes", async () => {
    const runtimeLocalWorkspace = {
      context: {
        stateDirectory: "/tmp/executor-tests",
      },
    };
    const firstManagedSourceCatalog = makeWorkspaceSourceCatalogManagerTestHandle();
    const secondManagedSourceCatalog = makeWorkspaceSourceCatalogManagerTestHandle();
    const workspaceSourceCatalogManagerTest = makeWorkspaceSourceCatalogManagerTestHandle({
      getOrRefresh: vi
        .fn()
        .mockReturnValueOnce(Effect.succeed(firstManagedSourceCatalog.managedSourceCatalog))
        .mockReturnValueOnce(Effect.succeed(secondManagedSourceCatalog.managedSourceCatalog)),
    });
    const createWorkspaceToolInvokerMock = vi.fn(({ sourceCatalog }: { sourceCatalog: unknown }) =>
      makeWorkspaceToolInvokerFake(sourceCatalog),
    );

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
        catalog: {
          semanticSearchSignature: null,
        },
      },
    ];

    const resolver = makeResolverInput({
      workspaceStateStore: {
        load: vi.fn(() => Effect.succeed(workspaceStates.shift()!)),
      },
      dependencies: {
        getRuntimeLocalWorkspaceOption: () => Effect.succeed(runtimeLocalWorkspace),
        loadConfiguredSemanticSearchEmbedder: () => Effect.succeed(undefined),
        workspaceSourceCatalogManager:
          workspaceSourceCatalogManagerTest.workspaceSourceCatalogManager as never,
        createWorkspaceToolInvoker: createWorkspaceToolInvokerMock,
      },
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

    expect(workspaceSourceCatalogManagerTest.calls.getOrRefresh).toHaveLength(2);
  });

  it("retries SQLite indexing after a failure for the same workspace signature", async () => {
    const runtimeLocalWorkspace = {
      context: {
        stateDirectory: "/tmp/executor-tests",
      },
    };
    const managedSourceCatalog = makeWorkspaceSourceCatalogManagerTestHandle();
    const workspaceSourceCatalogManagerTest = makeWorkspaceSourceCatalogManagerTestHandle({
      getOrRefresh: vi
        .fn()
        .mockReturnValueOnce(Effect.fail(new Error("sqlite unavailable")))
        .mockReturnValueOnce(Effect.succeed(managedSourceCatalog.managedSourceCatalog)),
    });
    const createWorkspaceToolInvokerMock = vi.fn(({ sourceCatalog }: { sourceCatalog: unknown }) =>
      makeWorkspaceToolInvokerFake(sourceCatalog),
    );

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
      catalog: {
        semanticSearchSignature: null,
      },
    };

    const resolver = makeResolverInput({
      workspaceStateStore: {
        load: () => Effect.succeed(workspaceState),
      },
      dependencies: {
        getRuntimeLocalWorkspaceOption: () => Effect.succeed(runtimeLocalWorkspace),
        loadConfiguredSemanticSearchEmbedder: () => Effect.succeed(undefined),
        workspaceSourceCatalogManager:
          workspaceSourceCatalogManagerTest.workspaceSourceCatalogManager as never,
        createWorkspaceToolInvoker: createWorkspaceToolInvokerMock,
      },
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

    expect(workspaceSourceCatalogManagerTest.calls.getOrRefresh).toHaveLength(2);
    expect(managedSourceCatalog.calls.close).toBe(0);
  });
});
