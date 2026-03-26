import type { AccountId, WorkspaceId } from "../../model";
import * as Effect from "effect/Effect";

import type {
  LoadedLocalExecutorConfig,
  ResolvedLocalWorkspaceContext,
} from "../engine/local-config";
import {
  LocalExecutorConfigDecodeError,
  LocalFileSystemError,
  RuntimeLocalWorkspaceMismatchError,
  RuntimeLocalWorkspaceUnavailableError,
} from "../engine/local-errors";
import {
  requireRuntimeLocalWorkspace,
  type RuntimeLocalWorkspaceState,
} from "../engine/runtime-context";
import {
  type WorkspaceConfigStoreShape,
  WorkspaceConfigStore,
} from "../engine/local-storage";
import type { EngineStoreShape } from "../engine/store";

export type RuntimeSourceStoreDeps = {
  rows: EngineStoreShape;
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
  rows: EngineStoreShape,
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
