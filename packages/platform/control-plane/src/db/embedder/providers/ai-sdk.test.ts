import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embedMock = vi.fn();
const embedManyMock = vi.fn();
const textEmbeddingModelMock = vi.fn();
const openaiFactoryMock = vi.fn();

vi.mock("ai", () => ({
  embed: embedMock,
  embedMany: embedManyMock,
}));

vi.mock("@ai-sdk/openai", () => ({
  openai: openaiFactoryMock,
}));

describe("createAiSdkEmbedder", () => {
  beforeEach(() => {
    embedMock.mockReset();
    embedManyMock.mockReset();
    textEmbeddingModelMock.mockReset();
    openaiFactoryMock.mockReset();

    textEmbeddingModelMock.mockReturnValue({ kind: "mock-model" });
    openaiFactoryMock.mockReturnValue({
      textEmbeddingModel: textEmbeddingModelMock,
    });
    embedMock.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
    embedManyMock.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] });
  });

  afterEach(() => {
  });

  it("loads a supported provider without mutating the runtime", async () => {
    const { createAiSdkEmbedder } = await import("./ai-sdk");

    const embedder = await createAiSdkEmbedder({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "test-key",
    });
    const embedding = await embedder.embed("hello");

    expect(openaiFactoryMock).toHaveBeenCalledWith({ apiKey: "test-key" });
    expect(textEmbeddingModelMock).toHaveBeenCalledWith(
      "text-embedding-3-small",
      undefined,
    );
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("passes through AI SDK model defaults when dimensions are omitted", async () => {
    const { createAiSdkEmbedder } = await import("./ai-sdk");

    await createAiSdkEmbedder({
      provider: "openai",
      model: "text-embedding-3-large",
      apiKey: "test-key",
    });

    expect(textEmbeddingModelMock).toHaveBeenCalledWith(
      "text-embedding-3-large",
      undefined,
    );
  });

  it("fails fast for unknown providers", async () => {
    const { createAiSdkEmbedder } = await import("./ai-sdk");

    await expect(
      createAiSdkEmbedder({
        provider: "unknown-provider",
        apiKey: "test-key",
      }),
    ).rejects.toThrow(/Unknown AI SDK provider/);
  });

  it("fails fast for providers that are not shipped in this branch", async () => {
    const { createAiSdkEmbedder } = await import("./ai-sdk");

    await expect(
      createAiSdkEmbedder({
        provider: "mistral",
        apiKey: "test-key",
      }),
    ).rejects.toThrow(/Unknown AI SDK provider/);
  });

  it("fails fast when the runtime does not provide a resolved api key", async () => {
    const { createAiSdkEmbedder } = await import("./ai-sdk");

    await expect(
      createAiSdkEmbedder({
        provider: "openai",
      }),
    ).rejects.toThrow(/requires a resolved api key/);
  });
});
