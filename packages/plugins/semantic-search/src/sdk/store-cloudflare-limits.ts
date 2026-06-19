import { Effect } from "effect";

import { SemanticSearchError } from "./errors";
import type { VectorStore, VectorInput } from "./store";

// ---------------------------------------------------------------------------
// Cloudflare Vectorize runtime limits — enforced as a decorator so the same
// validation applies equally to the real Vectorize binding and to zvec-based
// local / test setups.
//
// Limits (as of 2025):
//   • id:   max 64 bytes (UTF-8 encoded). The raw `${namespace}#${path}`
//           format used before the facet chunker could exceed this for long
//           OpenAPI paths — a failure found by deploying, not testing.
//   • metadata: max 10 KiB per vector. Tool descriptions from provider specs
//           can exceed this by themselves, so callers must store bounded
//           metadata and keep full text in the blob/document stores.
//   • topK: max 20 when `returnMetadata` is "all". `makeVectorizeStore` always
//           passes `returnMetadata: "all"`, so the query path is capped at 20.
//           We reject rather than clamp so the caller is forced to stay within
//           the budget instead of silently receiving fewer results than asked.
// ---------------------------------------------------------------------------

const MAX_ID_BYTES = 64;
const MAX_METADATA_BYTES = 10 * 1024;
const MAX_QUERY_TOP_K = 20;

// UTF-8 byte length via the Web-standard TextEncoder — available in the
// Cloudflare Workers runtime (and Node) without the `nodejs_compat` flag that
// `Buffer` would require.
const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

const metadataByteLength = (value: Record<string, unknown> | undefined): number => {
  if (value === undefined) return 0;
  return utf8ByteLength(JSON.stringify(value) ?? "null");
};

/** Wraps `inner` with Cloudflare Vectorize runtime-limit validation. Any call
 *  that would violate a limit fails immediately with `SemanticSearchError`
 *  before the inner store is touched. All other calls pass through unchanged.
 *  The returned store's `maxTopK` is `Math.min(inner.maxTopK, 20)`. */
export const withCloudflareLimits = (inner: VectorStore): VectorStore => ({
  maxTopK: Math.min(inner.maxTopK, MAX_QUERY_TOP_K),

  upsert: (vectors: readonly VectorInput[]) => {
    const offending = vectors.find((v) => utf8ByteLength(v.id) > MAX_ID_BYTES);
    if (offending !== undefined) {
      return Effect.fail(
        new SemanticSearchError({
          message: `Vector id exceeds the Cloudflare Vectorize 64-byte limit (${utf8ByteLength(offending.id)} bytes): "${offending.id}".`,
        }),
      );
    }
    const oversizedMetadata = vectors.find(
      (v) => metadataByteLength(v.metadata) > MAX_METADATA_BYTES,
    );
    if (oversizedMetadata !== undefined) {
      return Effect.fail(
        new SemanticSearchError({
          message: `Vector metadata exceeds the Cloudflare Vectorize 10 KiB limit (${metadataByteLength(oversizedMetadata.metadata)} bytes): "${oversizedMetadata.id}".`,
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
        new SemanticSearchError({
          message: `topK ${input.topK} exceeds the Cloudflare Vectorize limit of ${MAX_QUERY_TOP_K} when returnMetadata is "all". Lower topK or switch to a metadata strategy that supports a higher cap.`,
        }),
      );
    }
    return inner.query(input);
  },

  deleteByIds: inner.deleteByIds.bind(inner),
});
