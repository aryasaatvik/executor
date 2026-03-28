import * as Effect from "effect/Effect";
import type { CatalogStoreShape } from "@executor/core/ports";

export const createSqliteCatalogStore = (): CatalogStoreShape => ({
  getCatalogForSource: (_input) => Effect.fail(new Error("TODO: implement sqlite catalog store getCatalogForSource")),
  syncCatalog: (_input) => Effect.fail(new Error("TODO: implement sqlite catalog store syncCatalog")),
  searchTools: (_payload) => Effect.fail(new Error("TODO: implement sqlite catalog store searchTools")),
});
