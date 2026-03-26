import * as Effect from "effect/Effect";
import type { CatalogStoreShape } from "@executor/control-plane/ports";

// TODO: Implement with D1 + Drizzle in Phase 6

export const createD1CatalogStore = (): CatalogStoreShape => ({
  getCatalogForSource: (_input) => Effect.fail(new Error("TODO: implement D1 catalog store getCatalogForSource")),
  syncCatalog: (_input) => Effect.fail(new Error("TODO: implement D1 catalog store syncCatalog")),
  searchTools: (_payload) => Effect.fail(new Error("TODO: implement D1 catalog store searchTools")),
});
