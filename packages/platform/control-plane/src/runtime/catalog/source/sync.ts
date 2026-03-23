import { EXECUTOR_DB_FILENAME } from "../../../db/client.js"
import type {
  AccountId,
  Source,
  SourceStatus,
} from "#schema";
import type { McpToolManifest } from "@executor/source-mcp";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { join } from "node:path";

import {
  RuntimeLocalWorkspaceService,
  type RuntimeLocalWorkspaceState,
} from "../../local/runtime-context";
import {
  RuntimeSourceAuthMaterialService,
} from "../../auth/source-auth-material";
import {
  getSourceAdapterForSource,
} from "../../sources/source-adapters";
import {
  catalogSyncResultFromMcpManifest,
} from "@executor/source-mcp";
import { SecretMaterialResolverService } from "../../local/secret-material-providers";
import {
  refreshSourceTypeDeclarationInBackground,
} from "./type-declarations";
import { runtimeEffectError } from "../../effect-errors";
import { syncSourceToSqlite, upsertSourceStatusToDb } from "../../../db/indexer";
import {
  makeWorkspaceCatalogDbLayer,
} from "../../../db/setup";


const shouldIndexSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected"
  && getSourceAdapterForSource(source).catalogKind !== "internal";

type RuntimeSourceCatalogSyncDeps = {
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  resolveSecretMaterial: Effect.Effect.Success<typeof SecretMaterialResolverService>;
  sourceAuthMaterialService: Effect.Effect.Success<typeof RuntimeSourceAuthMaterialService>;
};

type SourceCatalogSyncServices =
  | RuntimeLocalWorkspaceService
  | RuntimeSourceAuthMaterialService
  | SecretMaterialResolverService;

export type RuntimeSourceCatalogSyncShape = {
  sync: (input: {
    source: Source;
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<void, Error, never>;
  persistMcpCatalogSnapshotFromManifest: (input: {
    source: Source;
    manifest: McpToolManifest;
  }) => Effect.Effect<void, Error, never>;
};

export class RuntimeSourceCatalogSyncService extends Context.Tag(
  "#runtime/RuntimeSourceCatalogSyncService",
)<RuntimeSourceCatalogSyncService, RuntimeSourceCatalogSyncShape>() {}

const ensureRuntimeCatalogSyncWorkspace = (
  deps: RuntimeSourceCatalogSyncDeps,
  workspaceId: Source["workspaceId"],
) => {
  if (deps.runtimeLocalWorkspace.installation.workspaceId !== workspaceId) {
    return Effect.fail(
      runtimeEffectError("catalog/source/sync",
        `Runtime local workspace mismatch: expected ${workspaceId}, got ${deps.runtimeLocalWorkspace.installation.workspaceId}`,
      ),
    );
  }

  return Effect.succeed(deps.runtimeLocalWorkspace.context);
};

const resolveDbPath = (deps: RuntimeSourceCatalogSyncDeps): string =>
  join(deps.runtimeLocalWorkspace.context.stateDirectory, EXECUTOR_DB_FILENAME);

const syncSourceCatalogWithDeps = (
  deps: RuntimeSourceCatalogSyncDeps,
  input: {
    source: Source;
    actorAccountId?: AccountId | null;
  },
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const workspaceContext = yield* ensureRuntimeCatalogSyncWorkspace(
      deps,
      input.source.workspaceId,
    );

    const dbPath = resolveDbPath(deps);
    const dbLayer = makeWorkspaceCatalogDbLayer(dbPath);

    if (!shouldIndexSource(input.source)) {
      // Write source status to SQLite for non-indexable sources
      yield* upsertSourceStatusToDb({
        sourceId: input.source.id,
        workspaceId: input.source.workspaceId,
        name: input.source.name,
        kind: input.source.kind,
        endpoint: input.source.endpoint,
        status: (input.source.enabled ? input.source.status : "draft") as SourceStatus,
        enabled: input.source.enabled,
        namespace: input.source.namespace,
        lastError: null,
        sourceHash: input.source.sourceHash,
        createdAt: input.source.createdAt,
        updatedAt: Date.now(),
      }).pipe(
        Effect.provide(dbLayer),
        Effect.catchAll(() => Effect.void),
      );

      yield* Effect.sync(() => {
        refreshSourceTypeDeclarationInBackground({
          context: workspaceContext,
          source: input.source,
          snapshot: null,
        });
      });
      return;
    }

    const adapter = getSourceAdapterForSource(input.source);
    const syncResult = yield* adapter.syncCatalog({
      source: input.source,
      resolveSecretMaterial: deps.resolveSecretMaterial,
      resolveAuthMaterialForSlot: (slot) =>
        deps.sourceAuthMaterialService.resolve({
          source: input.source,
          slot,
          actorAccountId: input.actorAccountId,
        }),
    });

    // Write catalog data + source status directly to SQLite
    const { snapshot } = yield* syncSourceToSqlite({
      source: input.source,
      syncResult,
    }).pipe(
      Effect.provide(dbLayer),
      Effect.mapError((e) => e instanceof Error ? e : new Error(String(e))),
    );

    yield* Effect.sync(() => {
      refreshSourceTypeDeclarationInBackground({
        context: workspaceContext,
        source: input.source,
        snapshot,
      });
    });
  }).pipe(
    Effect.withSpan("source.catalog.sync", {
      attributes: {
        "executor.source.id": input.source.id,
        "executor.source.kind": input.source.kind,
        "executor.source.namespace": input.source.namespace,
        "executor.source.endpoint": input.source.endpoint,
      },
    }),
  );

const persistMcpCatalogSnapshotFromManifestWithDeps = (
  deps: RuntimeSourceCatalogSyncDeps,
  input: {
    source: Source;
    manifest: McpToolManifest;
  },
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const workspaceContext = yield* ensureRuntimeCatalogSyncWorkspace(
      deps,
      input.source.workspaceId,
    );
    const syncResult = catalogSyncResultFromMcpManifest({
      source: input.source,
      endpoint: input.source.endpoint,
      manifest: input.manifest,
    });

    // Write catalog data directly to SQLite
    const dbPath = resolveDbPath(deps);
    const dbLayer = makeWorkspaceCatalogDbLayer(dbPath);
    const { snapshot } = yield* syncSourceToSqlite({
      source: input.source,
      syncResult,
    }).pipe(
      Effect.provide(dbLayer),
      Effect.mapError((e) => e instanceof Error ? e : new Error(String(e))),
    );

    yield* Effect.sync(() => {
      refreshSourceTypeDeclarationInBackground({
        context: workspaceContext,
        source: input.source,
        snapshot,
      });
    });
  });

export const syncSourceCatalog = (input: {
  source: Source;
  actorAccountId?: AccountId | null;
}): Effect.Effect<void, Error, SourceCatalogSyncServices> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    return yield* syncSourceCatalogWithDeps(
      {
        runtimeLocalWorkspace,
        resolveSecretMaterial,
        sourceAuthMaterialService,
      },
      {
        source: input.source,
        actorAccountId: input.actorAccountId,
      },
    );
  });

export const persistMcpCatalogSnapshotFromManifest = (input: {
  source: Source;
  manifest: McpToolManifest;
}): Effect.Effect<void, Error, SourceCatalogSyncServices> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    return yield* persistMcpCatalogSnapshotFromManifestWithDeps(
      {
        runtimeLocalWorkspace,
        resolveSecretMaterial,
        sourceAuthMaterialService,
      },
      input,
    );
  });

export const RuntimeSourceCatalogSyncLive = Layer.effect(
  RuntimeSourceCatalogSyncService,
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    const deps: RuntimeSourceCatalogSyncDeps = {
      runtimeLocalWorkspace,
      resolveSecretMaterial,
      sourceAuthMaterialService,
    };

    return RuntimeSourceCatalogSyncService.of({
      sync: (input) => syncSourceCatalogWithDeps(deps, input),
      persistMcpCatalogSnapshotFromManifest: (input) =>
        persistMcpCatalogSnapshotFromManifestWithDeps(deps, input),
    });
  }),
);
