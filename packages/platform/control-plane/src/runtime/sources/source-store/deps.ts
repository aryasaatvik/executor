import type { AccountId, WorkspaceId } from "#schema";
import * as Effect from "effect/Effect";

import type {
  LoadedLocalExecutorConfig,
  ResolvedLocalWorkspaceContext,
} from "../../local/config";
import {
  LocalExecutorConfigDecodeError,
  LocalFileSystemError,
  RuntimeLocalWorkspaceMismatchError,
  RuntimeLocalWorkspaceUnavailableError,
} from "../../local/errors";
import {
  requireRuntimeLocalWorkspace,
  type RuntimeLocalWorkspaceState,
} from "../../local/runtime-context";
import type {
  WorkspaceConfigStoreShape,
} from "../../local/storage";
import {
  WorkspaceConfigStore,
} from "../../local/storage";
import type { ControlPlaneStoreShape } from "../../store";

export type RuntimeSourceStoreDeps = {
  rows: ControlPlaneStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  workspaceConfigStore: WorkspaceConfigStoreShape;
};

export type ResolvedSourceStoreWorkspace = {
  context: ResolvedLocalWorkspaceContext;
  installation: {
    workspaceId: WorkspaceId;
    accountId: AccountId;
  };
  workspaceConfigStore: WorkspaceConfigStoreShape;
  loadedConfig: LoadedLocalExecutorConfig;
};

export const resolveRuntimeLocalWorkspaceFromDeps = (
  deps: RuntimeSourceStoreDeps,
  workspaceId: WorkspaceId,
): Effect.Effect<
  ResolvedSourceStoreWorkspace,
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalFileSystemError
  | LocalExecutorConfigDecodeError
  | Error,
  never
> =>
  Effect.gen(function* () {
    if (deps.runtimeLocalWorkspace.installation.workspaceId !== workspaceId) {
      return yield* new RuntimeLocalWorkspaceMismatchError({
          message: `Runtime local workspace mismatch: expected ${workspaceId}, got ${deps.runtimeLocalWorkspace.installation.workspaceId}`,
          requestedWorkspaceId: workspaceId,
          activeWorkspaceId: deps.runtimeLocalWorkspace.installation.workspaceId,
        });
    }

    const loadedConfig = yield* deps.workspaceConfigStore.load(
      deps.runtimeLocalWorkspace.context,
    );

    return {
      context: deps.runtimeLocalWorkspace.context,
      installation: deps.runtimeLocalWorkspace.installation,
      workspaceConfigStore: deps.workspaceConfigStore,
      loadedConfig,
    };
  });

export const loadRuntimeSourceStoreDeps = (
  rows: ControlPlaneStoreShape,
  workspaceId: WorkspaceId,
): Effect.Effect<
  RuntimeSourceStoreDeps,
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalFileSystemError
  | LocalExecutorConfigDecodeError
  | Error,
  WorkspaceConfigStore
> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace(workspaceId);
    const workspaceConfigStore = yield* WorkspaceConfigStore;

    return {
      rows,
      runtimeLocalWorkspace,
      workspaceConfigStore,
    };
  });
