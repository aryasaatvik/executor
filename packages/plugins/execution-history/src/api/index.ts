import { definePlugin } from "@executor-js/sdk/core";

import { executionHistoryPlugin } from "../sdk/plugin";
import { ExecutionHistoryGroup } from "./group";
import { ExecutionHistoryExtensionService, ExecutionHistoryHandlers } from "./handlers";

export {
  ExecutionHistoryGroup,
  ListRunsResponse,
  RunDetailResponse,
  ListToolCallsResponse,
} from "./group";
export {
  ExecutionHistoryHandlers,
  ExecutionHistoryExtensionService,
  type ExecutionHistoryExtension,
} from "./handlers";

// HTTP-augmented variant of `executionHistoryPlugin`. The returned plugin
// carries the HTTP `routes`, `handlers`, and `extensionService` so a host can
// mount the execution-history read API. Hosts that compose an `HttpApi` import
// this; SDK-only consumers stay on `@executor-js/plugin-execution-history` and
// never load `@executor-js/api`.
export const executionHistoryHttpPlugin = definePlugin(() => ({
  ...executionHistoryPlugin(),
  routes: () => ExecutionHistoryGroup,
  handlers: () => ExecutionHistoryHandlers,
  extensionService: ExecutionHistoryExtensionService,
}));
