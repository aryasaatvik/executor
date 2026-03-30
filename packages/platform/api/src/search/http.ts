import { HttpApiBuilder } from "@effect/platform";
import * as Effect from "effect/Effect";

import { ExecutorApi } from "../api";
import { ControlPlaneStorageError } from "../errors";
import { getControlPlaneExecutor } from "../executor-context";

const toStorageError = (operation: string) => (cause: unknown) =>
  new ControlPlaneStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    details: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });

export const ExecutorSearchLive = HttpApiBuilder.group(
  ExecutorApi,
  "search",
  (handlers) =>
    handlers
      .handle("status", () =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.search.status().pipe(
            Effect.mapError(toStorageError("search.status")),
          ),
        ),
      )
      .handle("refresh", () =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.search.refresh().pipe(
            Effect.mapError(toStorageError("search.refresh")),
          ),
        ),
      )
      .handle("rebuild", () =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.search.rebuild().pipe(
            Effect.mapError(toStorageError("search.rebuild")),
          ),
        ),
      ),
);
