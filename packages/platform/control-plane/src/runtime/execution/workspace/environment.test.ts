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

  it("probes non-local embedders when dimensions are not configured", async () => {
    const embed = vi.fn(async () => [1, 2, 3]);
    const embedder = {
      provider: "google",
      model: "gemini-embedding-2-preview",
      dimensions: 768,
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
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith("__executor_dimension_probe__", "document");
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
