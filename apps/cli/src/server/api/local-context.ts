import type { WorkspaceId } from "@executor/core/model";
import {
  requireRuntimeLocalWorkspace,
} from "@executor/core/services/engine/runtime-context";
import * as Effect from "effect/Effect";

import { EngineForbiddenError } from "./errors";

export const resolveRequestedLocalWorkspace = (
  operation: string,
  workspaceId: WorkspaceId,
) =>
  requireRuntimeLocalWorkspace(workspaceId).pipe(
    Effect.mapError((cause) =>
      new EngineForbiddenError({
        operation,
        message: "Requested workspace is not the active local workspace",
        details:
          cause !== null
          && typeof cause === "object"
          && "requestedWorkspaceId" in cause
          && "activeWorkspaceId" in cause
            ? `requestedWorkspaceId=${String(cause.requestedWorkspaceId)} activeWorkspaceId=${String(cause.activeWorkspaceId)}`
            : "Runtime local workspace is unavailable",
      })
    ),
  );
