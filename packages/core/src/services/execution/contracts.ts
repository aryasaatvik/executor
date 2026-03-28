import type { ToolMap } from "@executor/codemode-core";
import type { SourceAdapterRegistry } from "@executor/source-core";
import {
  getRuntimeLocalWorkspaceOption,
  provideOptionalRuntimeLocalWorkspace,
} from "../engine/runtime-context";
import type * as Effect from "effect/Effect";

import type { ResolvedLocalWorkspaceContext } from "../engine/local-config";
import type { WorkspaceConfigStoreShape } from "../engine/local-storage";
import type {
  ResolveSecretMaterial,
  SecretMaterialResolveContext,
} from "../engine/secret-material-store";
import type { RuntimeLocalWorkspaceState } from "../engine/runtime-context";
import type { RuntimeSourceAuthMaterialShape } from "../auth/source-auth-material";
import type { RuntimeSourceCatalogStoreShape } from "./source-catalog-store";

export type { RuntimeLocalWorkspaceState } from "../engine/runtime-context";
export {
  getRuntimeLocalWorkspaceOption,
  provideOptionalRuntimeLocalWorkspace,
} from "../engine/runtime-context";
export type {
  ResolveSecretMaterial,
  SecretMaterialResolveContext,
} from "../engine/secret-material-store";
export type { WorkspaceConfigStoreShape } from "../engine/local-storage";
export type { RuntimeSourceAuthMaterialShape } from "../auth/source-auth-material";
export type { RuntimeSourceCatalogStoreShape } from "./source-catalog-store";

export type ExecutionEmbedder = {
  dimensions: number;
  provider?: string;
  model?: string;
  embed?: (text: string, mode: "query" | "document") => Promise<number[]>;
  embedBatch?: (
    texts: readonly string[],
    mode: "query" | "document",
  ) => Promise<number[][]>;
  [key: string]: unknown;
};

export type LocalToolRuntime = {
  tools: ToolMap;
};

export type LocalToolRuntimeLoaderShape = {
  load: (
    context: ResolvedLocalWorkspaceContext,
  ) => Effect.Effect<LocalToolRuntime, unknown, never>;
};

export type ExecutionSourceCatalogStoreShape = Pick<
  RuntimeSourceCatalogStoreShape,
  "loadWorkspaceSourceCatalogToolIndex" | "loadWorkspaceSourceCatalogToolByPath"
>;

export type ExecutionSourceAdapterRegistryShape = Pick<
  SourceAdapterRegistry,
  "getSourceAdapter"
>;

export type {
  RuntimeLocalWorkspaceState as ExecutionRuntimeLocalWorkspaceState,
  ResolveSecretMaterial as ExecutionResolveSecretMaterial,
  SecretMaterialResolveContext as ExecutionSecretMaterialResolveContext,
  WorkspaceConfigStoreShape as ExecutionWorkspaceConfigStoreShape,
  RuntimeSourceAuthMaterialShape as ExecutionSourceAuthMaterialShape,
  RuntimeSourceCatalogStoreShape as ExecutionRuntimeSourceCatalogStoreShape,
};
