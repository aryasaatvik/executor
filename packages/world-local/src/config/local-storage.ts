import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import type { LocalExecutorConfig } from "@executor/core/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LocalInstallation } from "./installation";
import type {
  LoadedLocalExecutorConfig,
  ResolvedLocalWorkspaceContext,
} from "./config";
import {
  loadLocalExecutorConfig,
  resolveConfigRelativePath,
  writeProjectLocalExecutorConfig,
} from "./config";
import {
  getOrProvisionLocalInstallation,
  loadLocalInstallation,
} from "./installation";

export type InstallationStoreShape = {
  load: (
    context: ResolvedLocalWorkspaceContext,
  ) => Effect.Effect<LocalInstallation, never, never>;
  getOrProvision: (input: {
    context: ResolvedLocalWorkspaceContext;
  }) => Effect.Effect<LocalInstallation, never, never>;
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
  resolveRelativePath: (input: { path: string; workspaceRoot: string }) => string;
};

export class WorkspaceConfigStore extends Context.Tag(
  "#runtime/WorkspaceConfigStore",
)<WorkspaceConfigStore, WorkspaceConfigStoreShape>() {}

export type LocalStorageServices =
  | InstallationStore
  | WorkspaceConfigStore;

export type WorkspaceStorageServices =
  | WorkspaceConfigStore;

export const LocalInstallationStore: InstallationStoreShape = {
  load: loadLocalInstallation,
  getOrProvision: getOrProvisionLocalInstallation,
};

export const LocalInstallationStoreLive = Layer.succeed(
  InstallationStore,
  LocalInstallationStore,
);

const bindFileSystem = <A, E>(
  fileSystem: FileSystem.FileSystem,
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

const bindNodeFileSystem = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(NodeFileSystem.layer));

export const LocalWorkspaceConfigStore: WorkspaceConfigStoreShape = {
  load: (context) => bindNodeFileSystem(loadLocalExecutorConfig(context)),
  writeProject: (input) => bindNodeFileSystem(writeProjectLocalExecutorConfig(input)),
  resolveRelativePath: resolveConfigRelativePath,
};

export const LocalWorkspaceConfigStoreLive = Layer.effect(
  WorkspaceConfigStore,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return WorkspaceConfigStore.of({
      load: (context) => bindFileSystem(fileSystem, loadLocalExecutorConfig(context)),
      writeProject: (input) =>
        bindFileSystem(fileSystem, writeProjectLocalExecutorConfig(input)),
      resolveRelativePath: resolveConfigRelativePath,
    });
  }),
);

export const makeWorkspaceStorageLayer = (input: {
  workspaceConfigStore: WorkspaceConfigStoreShape;
}) =>
  Layer.succeed(WorkspaceConfigStore, input.workspaceConfigStore);

export const makeLocalStorageLayer = (input: {
  installationStore: InstallationStoreShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
}) =>
  Layer.mergeAll(
    Layer.succeed(InstallationStore, input.installationStore),
    makeWorkspaceStorageLayer(input),
  );

export const WorkspaceStorageLive = LocalWorkspaceConfigStoreLive;

export const LocalStorageLive = Layer.mergeAll(
  LocalInstallationStoreLive,
  WorkspaceStorageLive,
);
