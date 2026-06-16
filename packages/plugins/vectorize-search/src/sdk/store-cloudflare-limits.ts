import { Effect } from "effect";

import { VectorizeSearchError } from "./errors";
import type { VectorizeStore, VectorizeVectorInput } from "./vectorize";

// ---------------------------------------------------------------------------
// Cloudflare Vectorize runtime limits — enforced as a decorator so the same
// validation applies equally to the real Vectorize binding and to zvec-based
// local / test setups.
//
// Limits (as of 2025):
//   • id:   max 64 bytes (UTF-8 encoded). The raw `${namespace}#${path}`
//           format used before the facet chunker could exceed this for long
//           OpenAPI paths — a failure found by deploying, not testing.
//   • topK: max 20 when `returnMetadata` is "all". `makeVectorizeStore` always
//           passes `returnMetadata: "all"`, so the query path is capped at 20.
//           We reject rather than clamp so the caller is forced to stay within
//           the budget instead of silently receiving fewer results than asked.
// ---------------------------------------------------------------------------

const MAX_ID_BYTES = 64;
const MAX_QUERY_TOP_K = 20;

// UTF-8 byte length via the Web-standard TextEncoder — available in the
// Cloudflare Workers runtime (and Node) without the `nodejs_compat` flag that
// `Buffer` would require.
const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

/** Wraps `inner` with Cloudflare Vectorize runtime-limit validation. Any call
 *  that would violate a limit fails immediately with `VectorizeSearchError`
 *  before the inner store is touched. All other calls pass through unchanged. */
export const withCloudflareLimits = (inner: VectorizeStore): VectorizeStore => ({
  upsert: (vectors: readonly VectorizeVectorInput[]) => {
    const offending = vectors.find((v) => utf8ByteLength(v.id) > MAX_ID_BYTES);
    if (offending !== undefined) {
      return Effect.fail(
        new VectorizeSearchError({
          message: `Vector id exceeds the Cloudflare Vectorize 64-byte limit (${utf8ByteLength(offending.id)} bytes): "${offending.id}".`,
        }),
      );
    }
    return inner.upsert(vectors);
  },

  query: (input: {
    readonly vector: readonly number[];
    readonly namespace: string;
    readonly topK: number;
  }) => {
    if (input.topK > MAX_QUERY_TOP_K) {
      return Effect.fail(
        new VectorizeSearchError({
          message: `topK ${input.topK} exceeds the Cloudflare Vectorize limit of ${MAX_QUERY_TOP_K} when returnMetadata is "all". Lower topK or switch to a metadata strategy that supports a higher cap.`,
        }),
      );
    }
    return inner.query(input);
  },

  deleteByIds: inner.deleteByIds.bind(inner),
});
