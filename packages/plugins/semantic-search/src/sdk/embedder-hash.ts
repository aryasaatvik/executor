import { Effect } from "effect";

import type { ToolEmbedder } from "./embedder";

// ---------------------------------------------------------------------------
// Deterministic, dependency-free embedder for the harness + unit tests: a hashed
// bag-of-tokens vector, so cosine similarity reflects token overlap. It is NOT
// semantic — use the real Gemini embedder for relevance — but it is stable and
// meaningful enough to exercise the indexer → store → provider pipeline and to
// assert rankings in CI without an API key.
// ---------------------------------------------------------------------------

const tokenize = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);

const hashToken = (token: string, dimensions: number): number => {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % dimensions;
};

const embed = (text: string, dimensions: number): readonly number[] => {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    vector[hashToken(token, dimensions)]! += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vector.map((x) => x / norm);
};

export const makeHashEmbedder = (dimensions = 256): ToolEmbedder => ({
  model: "hash-test",
  dimensions,
  embedDocuments: (texts) => Effect.succeed(texts.map((text) => embed(text, dimensions))),
  embedQuery: (text) => Effect.succeed(embed(text, dimensions)),
});
