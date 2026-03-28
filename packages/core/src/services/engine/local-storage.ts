// Local storage services — copied from @executor/engine/src/runtime/local/storage.ts
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LocalExecutorConfig } from "../../model/index";
import type {
  LoadedLocalExecutorConfig,
  ResolvedLocalWorkspaceContext,
} from "./local-config";

export type InstallationStoreShape = {
  load: (
    context: ResolvedLocalWorkspaceContext,
  ) => Effect.Effect<unknown, never, never>;
  getOrProvision: (input: {
    context: ResolvedLocalWorkspaceContext;
  }) => Effect.Effect<unknown, never, never>;
};

export class InstallationStore extends Context.Tag(
  "#runtime/InstallationStore",
)<InstallationStore, InstallationStoreShape>() {}

export type WorkspaceConfigStoreShape = {
  load: (
    context: ResolvedLocalWorkspaceContext,
  ) => Effect.Effect<LoadedLocalExecutorConfig, Error, never>;
  writeProject: (input: {
    context: ResolvedLocalWorkspaceContext;
    config: LocalExecutorConfig;
  }) => Effect.Effect<void, Error, never>;
  resolveRelativePath: (input: {
    path: string;
    workspaceRoot: string;
  }) => string;
};

export class WorkspaceConfigStore extends Context.Tag(
  "#runtime/WorkspaceConfigStore",
)<WorkspaceConfigStore, WorkspaceConfigStoreShape>() {}

export type LocalStorageServices = InstallationStore | WorkspaceConfigStore;

export type WorkspaceStorageServices = WorkspaceConfigStore;

// Stub implementations — these are provided by the engine runtime at startup.
// Control-plane services receive them via Layer injection.
export const LocalInstallationStore: InstallationStoreShape = {
  load: () => {
    throw new Error(
      "LocalInstallationStore.load: not implemented in control-plane",
    );
  },
  getOrProvision: () => {
    throw new Error(
      "LocalInstallationStore.getOrProvision: not implemented in control-plane",
    );
  },
};

export const LocalWorkspaceConfigStore: WorkspaceConfigStoreShape = {
  load: () => {
    throw new Error(
      "LocalWorkspaceConfigStore.load: not implemented in control-plane",
    );
  },
  writeProject: () => {
    throw new Error(
      "LocalWorkspaceConfigStore.writeProject: not implemented in control-plane",
    );
  },
  resolveRelativePath: () => {
    throw new Error(
      "LocalWorkspaceConfigStore.resolveRelativePath: not implemented in control-plane",
    );
  },
};

export const makeLocalStorageLayer = (input: {
  installationStore: InstallationStoreShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
}) =>
  Layer.mergeAll(
    Layer.succeed(InstallationStore, input.installationStore),
    Layer.succeed(WorkspaceConfigStore, input.workspaceConfigStore),
  );
