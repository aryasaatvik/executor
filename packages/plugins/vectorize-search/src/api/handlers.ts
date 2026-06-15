import { Context, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { addGroup, captureEngineError } from "@executor-js/api";
import { ExecutorService } from "@executor-js/api/server";

import type { VectorizeSearchExtension } from "../sdk/plugin";
import { VectorizeSearchGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `executor.vectorizeSearch` surface. The host provides an
// already-bound extension via
// `Layer.succeed(VectorizeSearchExtensionService, executor.vectorizeSearch)`.
// The handler also yields the per-request `ExecutorService` (the scoped
// executor) and hands it to `reindex`, since the catalog lives on the executor,
// not the plugin ctx.
// ---------------------------------------------------------------------------

export class VectorizeSearchExtensionService extends Context.Service<
  VectorizeSearchExtensionService,
  VectorizeSearchExtension
>()("VectorizeSearchExtensionService") {}

const ExecutorApiWithVectorizeSearch = addGroup(VectorizeSearchGroup);

export const VectorizeSearchHandlers = HttpApiBuilder.group(
  ExecutorApiWithVectorizeSearch,
  "vectorizeSearch",
  (handlers) =>
    handlers.handle("reindex", () =>
      captureEngineError(
        Effect.gen(function* () {
          const search = yield* VectorizeSearchExtensionService;
          const executor = yield* ExecutorService;
          return yield* search.reindex(executor);
        }),
      ),
    ),
);
