import type { WorkspaceId } from "@executor/control-plane/model";
import {
  RuntimeLocalWorkspaceMismatchError,
  requireRuntimeLocalWorkspace,
} from "@executor/control-plane/services/engine/runtime-context";
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
          cause instanceof RuntimeLocalWorkspaceMismatchError
            ? `requestedWorkspaceId=${cause.requestedWorkspaceId} activeWorkspaceId=${cause.activeWorkspaceId}`
            : "Runtime local workspace is unavailable",
      })
    ),
  );
