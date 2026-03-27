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

import { EngineApi } from "../api";
import { resolveRequestedLocalWorkspace } from "../local-context";

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
            })
          ),
        ),
      )
      .handle("get", ({ path }) =>
        resolveRequestedLocalWorkspace("executions.get", path.workspaceId).pipe(
          Effect.zipRight(
            getExecution({
              workspaceId: path.workspaceId,
              executionId: path.executionId,
            }),
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
            })
          ),
        ),
      )
      .handle("list", ({ path }) =>
        resolveRequestedLocalWorkspace("executions.list", path.workspaceId).pipe(
          Effect.zipRight(
            listExecutions({
              workspaceId: path.workspaceId,
            }),
          ),
        ),
      )
      .handle("listSteps", ({ path }) =>
        resolveRequestedLocalWorkspace("executions.listSteps", path.workspaceId).pipe(
          Effect.zipRight(
            listExecutionSteps({
              workspaceId: path.workspaceId,
              executionId: path.executionId,
            }),
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
            })
          ),
        ),
      ),
);
