import { definePlugin } from "@executor-js/sdk/core";

import { runs } from "./collections";
import {
  type ExecutionHistoryStoreOptions,
  makeExecutionHistoryObserver,
  makeExecutionHistoryStore,
} from "./store";

export type ExecutionHistoryPluginOptions = ExecutionHistoryStoreOptions;

// ---------------------------------------------------------------------------
// Execution-history plugin (SDK surface). A pure sink: it contributes no tools
// or integrations, only the slim `runs` storage collection (the bulky per-run
// detail lives in an R2 object via `deps.blobs`), a read surface (`list`/`get`)
// on `executor.executionHistory`, and a runtime ExecutionObserver that records
// the engine's event stream.
//
// One store instance is shared: `storage(deps)` builds it (read methods +
// buffered `handleEvent` writer), `extension(ctx)` surfaces the read methods
// AND `handleEvent` off `ctx.storage`, and `runtime.executionObserver(self)`
// (which receives the EXTENSION) wraps `self.handleEvent` into an observer.
//
// The HTTP transport (routes/handlers/extensionService) is layered on by the
// api-aware factory in `@executor-js/plugin-execution-history/api`, so SDK-only
// consumers never load `@executor-js/api`.
// ---------------------------------------------------------------------------

export const executionHistoryPlugin = definePlugin((options?: ExecutionHistoryPluginOptions) => ({
  id: "executionHistory" as const,
  packageName: "@executor-js/plugin-execution-history",
  pluginStorage: { runs },
  storage: (deps) => makeExecutionHistoryStore(deps, options),
  extension: (ctx) => ({
    list: ctx.storage.list,
    get: ctx.storage.get,
    handleEvent: ctx.storage.handleEvent,
  }),
  runtime: {
    executionObserver: (self) => makeExecutionHistoryObserver(self),
  },
}));
