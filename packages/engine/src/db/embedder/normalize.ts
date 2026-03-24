/**
 * L2-normalize a vector in-place and return it.
 * Normalized vectors have unit length (magnitude = 1).
 * Required for cosine similarity when using truncated MRL embeddings.
 */
export function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0
  for (let i = 0; i < vector.length; i++) {
    sumSquares += vector[i] * vector[i]
  }

  if (sumSquares === 0) return vector

  const magnitude = Math.sqrt(sumSquares)
  for (let i = 0; i < vector.length; i++) {
    vector[i] /= magnitude
  }

  return vector
}
