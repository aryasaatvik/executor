import { definePlugin } from "@executor-js/sdk/core";

import { vectorizeSearchPlugin, type VectorizeSearchPluginOptions } from "../sdk/plugin";
import { VectorizeSearchGroup } from "./group";
import { VectorizeSearchExtensionService, VectorizeSearchHandlers } from "./handlers";

export { VectorizeSearchGroup, ReindexResponse } from "./group";
export { VectorizeSearchHandlers, VectorizeSearchExtensionService } from "./handlers";

// HTTP-augmented variant of `vectorizeSearchPlugin`. The returned plugin carries
// the reindex `routes`/`handlers`/`extensionService` so a host can mount the
// reindex endpoint. Hosts that compose an `HttpApi` import this; SDK-only
// consumers stay on `@executor-js/plugin-vectorize-search` and never load
// `@executor-js/api`.
export const vectorizeSearchHttpPlugin = definePlugin((options?: VectorizeSearchPluginOptions) => ({
  ...vectorizeSearchPlugin(options),
  routes: () => VectorizeSearchGroup,
  handlers: () => VectorizeSearchHandlers,
  extensionService: VectorizeSearchExtensionService,
}));
