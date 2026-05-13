import { definePlugin } from "@executor-js/sdk/core";

import { executionHistoryPlugin, type ExecutionHistoryPluginOptions } from "../sdk/plugin";
import { ExecutionHistoryGroup } from "./group";
import { ExecutionHistoryExtensionService, ExecutionHistoryHandlers } from "./handlers";

export { ExecutionHistoryGroup } from "./group";
export { ExecutionHistoryExtensionService, ExecutionHistoryHandlers } from "./handlers";

export const executionHistoryHttpPlugin = definePlugin(
  (options?: ExecutionHistoryPluginOptions) => ({
    ...executionHistoryPlugin(options),
    routes: () => ExecutionHistoryGroup,
    handlers: () => ExecutionHistoryHandlers,
    extensionService: ExecutionHistoryExtensionService,
  }),
);
