import { Context, Layer } from "effect";

import {
  type Chunker,
  type FacetChunkerOptions,
  makeFacetChunker,
  makeWholeChunker,
} from "./chunker";

// ---------------------------------------------------------------------------
// Pluggable chunker seam. The indexer depends on `ChunkerService`; the host
// (or eval harness) supplies ONE of the layers — the facet chunker (default,
// production) or the whole chunker (benchmark baseline).
// ---------------------------------------------------------------------------

export class ChunkerService extends Context.Service<ChunkerService, Chunker>()(
  "@executor-js/plugin-semantic-search/ChunkerService",
) {}

export const facetChunkerLayer = (options?: FacetChunkerOptions): Layer.Layer<ChunkerService> =>
  Layer.succeed(ChunkerService)(makeFacetChunker(options));

export const wholeChunkerLayer = (): Layer.Layer<ChunkerService> =>
  Layer.succeed(ChunkerService)(makeWholeChunker());
