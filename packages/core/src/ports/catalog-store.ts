import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  SourceId,
  StoredSourceCatalogRecord,
  ToolSearchPayload,
  ToolSearchResultSet,
} from "../model/index";

// TODO: Migrate to ServiceMap.Service when moving to Effect v4

export interface CatalogStoreShape {
  readonly getCatalogForSource: (input: {
    sourceId: SourceId;
  }) => Effect.Effect<StoredSourceCatalogRecord | null, Error>;

  readonly syncCatalog: (input: {
    sourceId: SourceId;
  }) => Effect.Effect<StoredSourceCatalogRecord, Error>;

  readonly searchTools: (
    payload: ToolSearchPayload,
  ) => Effect.Effect<ToolSearchResultSet, Error>;
}

export class CatalogStore extends Context.Tag(
  "@executor/core/CatalogStore",
)<CatalogStore, CatalogStoreShape>() {}
