import { Context, Layer } from "effect";

import { makeZVecStore, type ZVecStoreOptions } from "./store-zvec";
import { makeSqliteVecStore, type SqliteVecStoreOptions } from "./store-sqlite-vec";
import { makeVectorizeStore, type VectorizeIndex } from "./store-cloudflare";
import type { VectorStore } from "./store";

// ---------------------------------------------------------------------------
// Pluggable vector-store seam. The indexer + query provider depend on
// `VectorStoreService`; the host (or eval) supplies ONE of the layers — a local
// zvec ANN index for development or the Cloudflare Vectorize binding for
// production.
// ---------------------------------------------------------------------------

export class VectorStoreService extends Context.Service<VectorStoreService, VectorStore>()(
  "@executor-js/plugin-semantic-search/VectorStoreService",
) {}

export const vectorizeStoreLayer = (index: VectorizeIndex): Layer.Layer<VectorStoreService> =>
  Layer.succeed(VectorStoreService)(makeVectorizeStore(index));

export const zvecStoreLayer = (options: ZVecStoreOptions): Layer.Layer<VectorStoreService> =>
  Layer.succeed(VectorStoreService)(makeZVecStore(options));

export const sqliteVecStoreLayer = (
  options: SqliteVecStoreOptions,
): Layer.Layer<VectorStoreService> =>
  Layer.succeed(VectorStoreService)(makeSqliteVecStore(options));
