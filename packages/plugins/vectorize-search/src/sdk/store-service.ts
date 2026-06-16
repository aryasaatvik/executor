import { Context, Layer } from "effect";

import { makeZVecStore, type ZVecStoreOptions } from "./store-zvec";
import { makeVectorizeStore, type VectorizeIndex, type VectorizeStore } from "./vectorize";

// ---------------------------------------------------------------------------
// Pluggable vector-store seam. The indexer + query provider depend on
// `VectorStoreService`; the host (or eval) supplies ONE of the layers — a local
// zvec ANN index for development or the Cloudflare Vectorize binding for
// production.
// ---------------------------------------------------------------------------

export class VectorStoreService extends Context.Service<VectorStoreService, VectorizeStore>()(
  "@executor-js/plugin-vectorize-search/VectorStoreService",
) {}

export const vectorizeStoreLayer = (index: VectorizeIndex): Layer.Layer<VectorStoreService> =>
  Layer.succeed(VectorStoreService)(makeVectorizeStore(index));

export const zvecStoreLayer = (options: ZVecStoreOptions): Layer.Layer<VectorStoreService> =>
  Layer.succeed(VectorStoreService)(makeZVecStore(options));
