import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { InternalError } from "@executor-js/api";

// ---------------------------------------------------------------------------
// HTTP surface for the Vectorize search plugin: a single explicit reindex.
//
// The route is flat and plugin-id-prefixed (`/vectorize-search/reindex`),
// matching the execution-history/graphql convention — the per-request executor
// is already owner-scoped at the host edge, so there is no `:scopeId` segment.
//
// Reindex takes no body: it reconciles the whole tool catalog for the scoped
// tenant against Vectorize (incremental fingerprint diff). `VectorizeSearchError`
// on the extension flows through the typed channel and `capture` downgrades it
// to `InternalError`.
// ---------------------------------------------------------------------------

/** Result of a reindex reconcile: counts for each category of tool processed. */
export const ReindexResponse = Schema.Struct({
  namespace: Schema.String,
  total: Schema.Number,
  reembedded: Schema.Number,
  unchanged: Schema.Number,
  removedSkipped: Schema.Number,
});

export const VectorizeSearchGroup = HttpApiGroup.make("vectorizeSearch").add(
  HttpApiEndpoint.post("reindex", "/vectorize-search/reindex", {
    success: ReindexResponse,
    error: InternalError,
  }),
);
