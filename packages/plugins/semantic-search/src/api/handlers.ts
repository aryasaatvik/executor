import { Context, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { addGroup, captureEngineError } from "@executor-js/api";
import { ExecutorService } from "@executor-js/api/server";

import type { SemanticSearchExtension } from "../sdk/plugin";
import { SemanticSearchGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `executor.semanticSearch` surface. The host provides an
// already-bound extension via
// `Layer.succeed(SemanticSearchExtensionService, executor.semanticSearch)`.
// The handler also yields the per-request `ExecutorService` (the scoped
// executor) and hands it to `reindex`, since the catalog lives on the executor,
// not the plugin ctx.
// ---------------------------------------------------------------------------

export class SemanticSearchExtensionService extends Context.Service<
  SemanticSearchExtensionService,
  SemanticSearchExtension
>()("SemanticSearchExtensionService") {}

const ExecutorApiWithSemanticSearch = addGroup(SemanticSearchGroup);

export const SemanticSearchHandlers = HttpApiBuilder.group(
  ExecutorApiWithSemanticSearch,
  "semanticSearch",
  (handlers) =>
    handlers
      .handle("reindex", () =>
        captureEngineError(
          Effect.gen(function* () {
            const search = yield* SemanticSearchExtensionService;
            const executor = yield* ExecutorService;
            return yield* search.reindex(executor);
          }),
        ),
      )
      .handle("search", ({ query }) =>
        captureEngineError(
          Effect.gen(function* () {
            const search = yield* SemanticSearchExtensionService;
            const executor = yield* ExecutorService;
            return yield* search.search(executor, {
              query: query.q,
              namespace: query.namespace,
              limit: query.limit,
            });
          }),
        ),
      )
      .handle("status", () =>
        captureEngineError(
          Effect.gen(function* () {
            const search = yield* SemanticSearchExtensionService;
            return yield* search.status();
          }),
        ),
      ),
);
