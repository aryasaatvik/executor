import { definePlugin } from "@executor-js/sdk/core";

import {
  executionHistorySchema,
  makeExecutionHistoryObserver,
  makeExecutionHistoryStore,
  type ExecutionHistoryStore,
  type ExecutionHistoryListOptions,
} from "./store";

export interface ExecutionHistoryPluginExtension {
  readonly list: ExecutionHistoryStore["list"];
  readonly get: ExecutionHistoryStore["get"];
  readonly listToolCalls: ExecutionHistoryStore["listToolCalls"];
  readonly handleEvent: ExecutionHistoryStore["handleEvent"];
}

export interface ExecutionHistoryPluginOptions {}

export type { ExecutionHistoryListOptions };

const makeExecutionHistoryExtension = (
  store: ExecutionHistoryStore,
): ExecutionHistoryPluginExtension => ({
  list: (options) => store.list(options),
  get: (executionId) => store.get(executionId),
  listToolCalls: (executionId) => store.listToolCalls(executionId),
  handleEvent: (event) => store.handleEvent(event),
});

export const executionHistoryPlugin = definePlugin((_: ExecutionHistoryPluginOptions = {}) => ({
  id: "executionHistory" as const,
  packageName: "@executor-js/plugin-execution-history",
  schema: executionHistorySchema,
  storage: (deps): ExecutionHistoryStore => makeExecutionHistoryStore(deps),
  extension: (ctx) => makeExecutionHistoryExtension(ctx.storage),
  runtime: {
    executionObserver: (self) => makeExecutionHistoryObserver(self),
  },
}));
