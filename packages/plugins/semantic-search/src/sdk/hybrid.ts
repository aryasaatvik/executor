import {
  ExecutionToolError,
  type PagedResult,
  type ToolDiscoveryProvider,
  type ToolDiscoveryResult,
} from "@executor-js/sdk/core";
import { Effect } from "effect";

// ---------------------------------------------------------------------------
// Hybrid Reciprocal Rank Fusion (RRF) provider.
//
// Calls both a lexical and a vector provider concurrently, fuses their
// per-path scores with RRF, and paginates the fused list.  The module is
// intentionally PURE — it takes both providers as arguments and never imports
// the engine's default provider.  The plugin wires that in.
// ---------------------------------------------------------------------------

/** Tuning knobs for Reciprocal Rank Fusion. */
export interface HybridOptions {
  /**
   * Per-source weight applied before summing contributions.
   * Default: `{ lexical: 0.7, vector: 0.3 }`.
   */
  readonly weights?: {
    readonly lexical: number;
    readonly vector: number;
  };
  /**
   * The RRF rank-offset constant (`k` in `w / (k + rank)`).
   * Default: 60 (Pi's value; large k dampens early-rank dominance).
   */
  readonly k?: number;
  /**
   * How many items to request from EACH provider before fusing.
   * Default: 50.
   */
  readonly fuseDepth?: number;
}

// Resolved defaults used throughout.
const DEFAULT_WEIGHTS = { lexical: 0.7, vector: 0.3 } as const;
const DEFAULT_K = 60;
const DEFAULT_FUSE_DEPTH = 50;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Per-path accumulator keyed by `path`. */
type FusedEntry = {
  readonly path: string;
  score: number;
  // We keep the richest ToolDiscoveryResult seen for this path.
  result: ToolDiscoveryResult;
};

/**
 * Accumulate RRF contributions from one provider's ranked list into `acc`.
 * `weight` is the source-specific weight; `k` is the RRF constant.
 */
const accumulateSource = (
  acc: Map<string, FusedEntry>,
  items: readonly ToolDiscoveryResult[],
  weight: number,
  k: number,
): void => {
  for (let rank = 0; rank < items.length; rank++) {
    const item = items[rank]!;
    const contribution = weight / (k + rank);
    const existing = acc.get(item.path);
    if (existing === undefined) {
      acc.set(item.path, {
        path: item.path,
        score: contribution,
        result: item,
      });
    } else {
      existing.score += contribution;
      // Prefer the richer result: the one with a non-empty description wins.
      if (
        (existing.result.description === undefined || existing.result.description.length === 0) &&
        item.description !== undefined &&
        item.description.length > 0
      ) {
        existing.result = item;
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build a `ToolDiscoveryProvider` that fuses a lexical and a vector provider
 * using Reciprocal Rank Fusion.
 *
 * Both providers are called concurrently with `{ ...input, limit: fuseDepth,
 * offset: 0 }` so the full over-fetch window is available for ranking,
 * regardless of the caller's pagination parameters.  The caller's `offset` and
 * `limit` are applied to the fused, sorted list.
 */
export const makeHybridToolDiscoveryProvider = (deps: {
  readonly lexical: ToolDiscoveryProvider;
  readonly vector: ToolDiscoveryProvider;
  readonly options?: HybridOptions;
}): ToolDiscoveryProvider => {
  const weights = deps.options?.weights ?? DEFAULT_WEIGHTS;
  const k = deps.options?.k ?? DEFAULT_K;
  const fuseDepth = deps.options?.fuseDepth ?? DEFAULT_FUSE_DEPTH;

  return {
    searchTools: (input) =>
      Effect.gen(function* () {
        const fetchInput = { ...input, limit: fuseDepth, offset: 0 };

        // Fetch both sources concurrently; propagate any failure immediately.
        const [lexicalPage, vectorPage] = yield* Effect.all(
          [deps.lexical.searchTools(fetchInput), deps.vector.searchTools(fetchInput)] as const,
          { concurrency: "unbounded" },
        );

        // Build the fused score map.
        const acc = new Map<string, FusedEntry>();
        accumulateSource(acc, lexicalPage.items, weights.lexical, k);
        accumulateSource(acc, vectorPage.items, weights.vector, k);

        // Sort by fused score desc; tie-break by path asc for determinism.
        const fused = [...acc.values()].sort((a, b) => {
          const diff = b.score - a.score;
          if (diff !== 0) return diff;
          return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
        });

        // Apply the caller's pagination to the fused list.
        const safeOffset = Math.max(input.offset, 0);
        const start = Math.min(safeOffset, fused.length);
        const pageEntries = fused.slice(start, start + input.limit);
        const hasMore = fused.length > start + pageEntries.length;

        const items: readonly ToolDiscoveryResult[] = pageEntries.map((entry) => ({
          ...entry.result,
          score: entry.score,
        }));

        return {
          items,
          total: fused.length,
          hasMore,
          nextOffset: hasMore ? start + pageEntries.length : null,
        } satisfies PagedResult<ToolDiscoveryResult>;
      }).pipe(
        Effect.mapError(
          (cause) => new ExecutionToolError({ message: "Hybrid RRF tool search failed.", cause }),
        ),
      ),
  };
};
