import { HttpApiBuilder } from "@effect/platform";
import * as Effect from "effect/Effect";
import {
  closeExecutionSession,
  createExecution,
  getExecution,
  listExecutionSteps,
  listExecutions,
  resumeExecution,
} from "@executor/control-plane/services/execution";
import {
  EngineStorageError,
} from "../errors";

import { EngineApi } from "../api";
import { resolveRequestedLocalWorkspace } from "../local-context";

const toExecutionStorageError = (operation: string, cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new EngineStorageError({
    operation,
    message,
    details: message,
  });
};

export const EngineExecutionsLive = HttpApiBuilder.group(
  EngineApi,
  "executions",
  (handlers) =>
    handlers
      .handle("create", ({ path, payload }) =>
        resolveRequestedLocalWorkspace("executions.create", path.workspaceId).pipe(
          Effect.flatMap((runtimeLocalWorkspace) =>
            createExecution({
              workspaceId: path.workspaceId,
              payload,
              createdByAccountId: runtimeLocalWorkspace.installation.accountId,
            }).pipe(
              Effect.mapError((cause) =>
                toExecutionStorageError("executions.create", cause),
              ),
            )
          ),
        ),
      )
      .handle("get", ({ path }) =>
        resolveRequestedLocalWorkspace("executions.get", path.workspaceId).pipe(
          Effect.zipRight(
            getExecution({
              workspaceId: path.workspaceId,
              executionId: path.executionId,
            }).pipe(
              Effect.mapError((cause) =>
                toExecutionStorageError("executions.get", cause),
              ),
            ),
          ),
        ),
      )
      .handle("resume", ({ path, payload }) =>
        resolveRequestedLocalWorkspace("executions.resume", path.workspaceId).pipe(
          Effect.flatMap((runtimeLocalWorkspace) =>
            resumeExecution({
              workspaceId: path.workspaceId,
              executionId: path.executionId,
              payload,
              resumedByAccountId: runtimeLocalWorkspace.installation.accountId,
            }).pipe(
              Effect.mapError((cause) =>
                toExecutionStorageError("executions.resume", cause),
              ),
            )
          ),
        ),
      )
      .handle("list", ({ path }) =>
        resolveRequestedLocalWorkspace("executions.list", path.workspaceId).pipe(
          Effect.zipRight(
            listExecutions({
              workspaceId: path.workspaceId,
            }).pipe(
              Effect.mapError((cause) =>
                toExecutionStorageError("executions.list", cause),
              ),
            ),
          ),
        ),
      )
      .handle("listSteps", ({ path }) =>
        resolveRequestedLocalWorkspace("executions.listSteps", path.workspaceId).pipe(
          Effect.zipRight(
            listExecutionSteps({
              workspaceId: path.workspaceId,
              executionId: path.executionId,
            }).pipe(
              Effect.mapError((cause) =>
                toExecutionStorageError("executions.listSteps", cause),
              ),
            ),
          ),
        ),
      )
      .handle("closeSession", ({ path }) =>
        resolveRequestedLocalWorkspace("executions.closeSession", path.workspaceId).pipe(
          Effect.flatMap((runtimeLocalWorkspace) =>
            closeExecutionSession({
              workspaceId: path.workspaceId,
              executionSessionId: path.executionSessionId,
              accountId: runtimeLocalWorkspace.installation.accountId,
            }).pipe(
              Effect.mapError((cause) =>
                toExecutionStorageError("executions.closeSession", cause),
              ),
            )
          ),
        ),
      ),
);
