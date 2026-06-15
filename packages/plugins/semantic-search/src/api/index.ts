import { definePlugin } from "@executor-js/sdk/core";

import { semanticSearchPlugin, type SemanticSearchPluginOptions } from "../sdk/plugin";
import { SemanticSearchGroup } from "./group";
import { SemanticSearchExtensionService, SemanticSearchHandlers } from "./handlers";

export { SemanticSearchGroup, ReindexResponse } from "./group";
export { SemanticSearchHandlers, SemanticSearchExtensionService } from "./handlers";

// HTTP-augmented variant of `semanticSearchPlugin`. The returned plugin carries
// the reindex `routes`/`handlers`/`extensionService` so a host can mount the
// reindex endpoint. Hosts that compose an `HttpApi` import this; SDK-only
// consumers stay on `@executor-js/plugin-semantic-search` and never load
// `@executor-js/api`.
export const semanticSearchHttpPlugin = definePlugin((options?: SemanticSearchPluginOptions) => ({
  ...semanticSearchPlugin(options),
  routes: () => SemanticSearchGroup,
  handlers: () => SemanticSearchHandlers,
  extensionService: SemanticSearchExtensionService,
}));
