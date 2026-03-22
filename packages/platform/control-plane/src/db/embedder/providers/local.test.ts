import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveModelFileMock = vi.fn();
const loadModelMock = vi.fn();
const getLlamaMock = vi.fn();
const getEmbeddingForMock = vi.fn();
const createEmbeddingContextMock = vi.fn();

vi.mock("node-llama-cpp", () => ({
  getLlama: getLlamaMock,
  resolveModelFile: resolveModelFileMock,
}));

describe("createLocalEmbedder", () => {
  beforeEach(() => {
    resolveModelFileMock.mockReset();
    loadModelMock.mockReset();
    getLlamaMock.mockReset();
    getEmbeddingForMock.mockReset();
    createEmbeddingContextMock.mockReset();

    getEmbeddingForMock.mockResolvedValue({
      vector: new Float32Array([0.1, 0.2, 0.3]),
    });
    createEmbeddingContextMock.mockResolvedValue({
      getEmbeddingFor: getEmbeddingForMock,
    });
    loadModelMock.mockResolvedValue({
      createEmbeddingContext: createEmbeddingContextMock,
    });
    getLlamaMock.mockResolvedValue({
      cpuMathCores: 4,
      gpu: false,
      loadModel: loadModelMock,
    });
    resolveModelFileMock.mockResolvedValue("/tmp/model.gguf");
  });

  it("uses the default qwen model URI when no explicit model is configured", async () => {
    const { createLocalEmbedder } = await import("./local");
    const embedder = await createLocalEmbedder({ provider: "local" });

    await embedder.embed("hello");

    expect(resolveModelFileMock).toHaveBeenCalledWith(
      "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      expect.any(String),
    );
  });

  it("passes explicit model identifiers through without rewriting them", async () => {
    const { createLocalEmbedder } = await import("./local");
    const embedder = await createLocalEmbedder({
      provider: "local",
      model: "hf:my-org/custom-embedder/custom.gguf",
    });

    await embedder.embed("hello");

    expect(resolveModelFileMock).toHaveBeenCalledWith(
      "hf:my-org/custom-embedder/custom.gguf",
      expect.any(String),
    );
  });
});
