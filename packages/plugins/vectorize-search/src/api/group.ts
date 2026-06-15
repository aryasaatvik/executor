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
// Reindex takes no body: it embeds the whole tool catalog for the scoped tenant
// and upserts it into Vectorize. `VectorizeSearchError` on the extension flows
// through the typed channel and `capture` downgrades it to `InternalError`.
// ---------------------------------------------------------------------------

/** Result of a reindex: the namespace touched + the number of tools embedded
 *  and upserted into Vectorize. */
export const ReindexResponse = Schema.Struct({
  namespace: Schema.String,
  indexedToolCount: Schema.Number,
});

export const VectorizeSearchGroup = HttpApiGroup.make("vectorizeSearch").add(
  HttpApiEndpoint.post("reindex", "/vectorize-search/reindex", {
    success: ReindexResponse,
    error: InternalError,
  }),
);
