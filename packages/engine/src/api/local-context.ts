import type { WorkspaceId } from "#schema";
import * as Effect from "effect/Effect";

import {
  RuntimeLocalWorkspaceMismatchError,
} from "../runtime/local/errors";
import { requireRuntimeLocalWorkspace } from "../runtime/local/runtime-context";
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
