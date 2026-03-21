import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

const createEmbedderMock = vi.fn();
const createWorkspaceToolInvokerMock = vi.fn();
const indexWorkspaceToolsIntoSqliteMock = vi.fn();

vi.mock("../../../db/embedder", () => ({
  createEmbedder: createEmbedderMock,
}));

vi.mock("./tool-invoker", () => ({
  createWorkspaceToolInvoker: createWorkspaceToolInvokerMock,
}));

vi.mock("./source-catalog", () => ({
  indexWorkspaceToolsIntoSqlite: indexWorkspaceToolsIntoSqliteMock,
}));

describe("loadConfiguredSemanticSearchEmbedder", () => {
  beforeEach(async () => {
    createEmbedderMock.mockReset();
    createWorkspaceToolInvokerMock.mockReset();
    indexWorkspaceToolsIntoSqliteMock.mockReset();
    const environmentModule = await import("./environment");
    environmentModule.clearSemanticSearchEmbedderCacheForTests();
  });

  it("reuses the same embedder for repeated identical configs", async () => {
    const embedder = {
      provider: "local",
      model: "test-model",
      dimensions: 384,
      embed: async () => [1, 2, 3],
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
