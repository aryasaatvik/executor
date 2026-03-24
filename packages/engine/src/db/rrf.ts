import type { ToolPath } from "@executor/codemode-core"

export interface RankedResult {
  path: ToolPath
  score: number
}

export interface RankedList {
  results: readonly RankedResult[]
  weight: number
}

/**
 * Reciprocal Rank Fusion — merges multiple ranked result lists.
 *
 * Formula per result: accumulated_score += weight / (K + rank + 1)
 * where rank is 0-based position in each list.
 *
 * @param lists - Ranked result lists with weights
 * @param k - RRF constant (default 60)
 * @param limit - Max results to return
 */
export function reciprocalRankFusion(
  lists: readonly RankedList[],
  k: number = 60,
  limit: number = 20,
): RankedResult[] {
  const scores = new Map<string, number>()

  for (const list of lists) {
    for (let rank = 0; rank < list.results.length; rank++) {
      const result = list.results[rank]
      const rrf = list.weight / (k + rank + 1)
      scores.set(result.path, (scores.get(result.path) ?? 0) + rrf)
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, score]) => ({ path: path as ToolPath, score }))
}
