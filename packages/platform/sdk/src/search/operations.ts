import * as Effect from "effect/Effect";

import {
  RuntimeSearchManagerService,
} from "../runtime/search/manager";

export const getSearchStatus = () =>
  Effect.flatMap(RuntimeSearchManagerService, (searchManager) =>
    searchManager.status(),
  );

export const refreshSearchIndex = () =>
  Effect.flatMap(RuntimeSearchManagerService, (searchManager) =>
    searchManager.refresh(),
  );

export const rebuildSearchIndex = () =>
  Effect.flatMap(RuntimeSearchManagerService, (searchManager) =>
    searchManager.rebuild(),
  );
