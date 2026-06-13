import { definePlugin } from "@executor-js/sdk/core";

import { interactions, runs, toolCalls } from "./collections";
import { makeExecutionHistoryObserver, makeExecutionHistoryStore } from "./store";

// ---------------------------------------------------------------------------
// Execution-history plugin. A pure sink: it contributes no tools or
// integrations, only the three storage collections, a read surface
// (`list`/`get`/`listToolCalls`) on `executor.executionHistory`, and a runtime
// ExecutionObserver that records the engine's event stream.
//
// One store instance is shared: `storage(deps)` builds it (read methods +
// buffered `handleEvent` writer), `extension(ctx)` surfaces the read methods
// AND `handleEvent` off `ctx.storage`, and `runtime.executionObserver(self)`
// (which receives the EXTENSION) wraps `self.handleEvent` into an observer.
// ---------------------------------------------------------------------------

export const executionHistoryPlugin = definePlugin(() => ({
  id: "executionHistory" as const,
  packageName: "@executor-js/plugin-execution-history",
  pluginStorage: { runs, toolCalls, interactions },
  storage: (deps) => makeExecutionHistoryStore(deps),
  extension: (ctx) => ({
    list: ctx.storage.list,
    get: ctx.storage.get,
    listToolCalls: ctx.storage.listToolCalls,
    handleEvent: ctx.storage.handleEvent,
  }),
  runtime: {
    executionObserver: (self) => makeExecutionHistoryObserver(self),
  },
}))();
