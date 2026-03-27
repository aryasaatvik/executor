import type * as Layer from "effect/Layer";
import type * as ManagedRuntime from "effect/ManagedRuntime";

import type { AccountId, WorkspaceId } from "./model";
import type { ResolveExecutionEnvironment } from "./services/execution/execution-state";
import type { ResolveSecretMaterial } from "./services/engine/secret-material-store";

export type ControlPlaneOptions = {
  readonly executionResolver?: ResolveExecutionEnvironment;
  readonly resolveSecretMaterial?: ResolveSecretMaterial;
  readonly getLocalServerBaseUrl?: () => string | undefined;
  readonly localDataDir?: string;
  readonly workspaceRoot?: string;
  readonly homeConfigPath?: string;
  readonly homeStateDirectory?: string;
};

export type ControlPlanePortContext = unknown;

export type ControlPlaneRuntimeContext = unknown;

export type ControlPlaneRuntimeLayer = Layer.Layer<
  ControlPlaneRuntimeContext,
  never,
  never
>;

export type ControlPlane = {
  readonly installation: {
    readonly workspaceId: WorkspaceId;
    readonly accountId: AccountId;
  };
  readonly runtimeLayer: ControlPlaneRuntimeLayer;
  readonly managedRuntime: ManagedRuntime.ManagedRuntime<
    any,
    never
  >;
  readonly apiLayer: Layer.Layer<any, any, never>;
  readonly close: () => Promise<void>;
};
