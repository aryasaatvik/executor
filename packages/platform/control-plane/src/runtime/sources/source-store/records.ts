import type {
  AccountId,
  AuthArtifact,
  Source,
  SourceId,
  WorkspaceId,
} from "#schema";
import { SourceIdSchema } from "#schema";
import * as Effect from "effect/Effect";

import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { eq, and, desc } from "drizzle-orm";
import type { CatalogSnapshotV1, CatalogV1, Capability, Executable } from "@executor/ir/model";

import { sourceAuthFromAuthArtifact } from "../../auth/auth-artifacts";
import { authArtifactSecretMaterialRefs } from "../../auth/auth-artifacts";
import { refreshWorkspaceSourceTypeDeclarationsInBackground } from "../../catalog/source/type-declarations";
import type { LoadedLocalExecutorConfig } from "../../local/config";
import {
  LocalConfiguredSourceNotFoundError,
  LocalExecutorConfigDecodeError,
  LocalFileSystemError,
  RuntimeLocalWorkspaceMismatchError,
  RuntimeLocalWorkspaceUnavailableError,
} from "../../local/errors";
import { getSourceAdapter } from "../source-adapters";
import {
  resolveRuntimeLocalWorkspaceFromDeps,
  type RuntimeSourceStoreDeps,
} from "./deps";
import {
  selectPreferredAuthArtifact,
} from "./auth";
import {
  sourceAuthFromConfigInput,
  trimOrNull,
} from "./config";
import { catalog_tool, catalog_revision } from "../../../db/schema";
import { stableSourceCatalogId } from "../source-definitions";
import { loadSourceStatus, type SourceStatusRecord } from "../../../db/source-state";
import {
  makeWorkspaceDatabase,
} from "../../local/workspace-database";

export const buildLocalSourceRecord = (input: {
  workspaceId: WorkspaceId;
  loadedConfig: LoadedLocalExecutorConfig;
  sourceStatus: SourceStatusRecord | null;
  sourceId: SourceId;
  actorAccountId?: AccountId | null;
  authArtifacts: ReadonlyArray<AuthArtifact>;
}): Effect.Effect<
  {
    source: Source;
    sourceId: SourceId;
  },
  LocalConfiguredSourceNotFoundError | Error,
  never
> =>
  Effect.gen(function* () {
    const sourceConfig = input.loadedConfig.config?.sources?.[input.sourceId];
    if (!sourceConfig) {
      return yield* new LocalConfiguredSourceNotFoundError({
          message: `Configured source not found for id ${input.sourceId}`,
          sourceId: input.sourceId,
        });
    }

    const existingState = input.sourceStatus;
    const adapter = getSourceAdapter(sourceConfig.kind);
    const baseSource = (yield* adapter.validateSource({
      id: SourceIdSchema.make(input.sourceId),
      workspaceId: input.workspaceId,
      name: trimOrNull(sourceConfig.name) ?? input.sourceId,
      kind: sourceConfig.kind,
      endpoint: sourceConfig.connection.endpoint.trim(),
      status:
        existingState?.status ??
        (sourceConfig.enabled ?? true ? "connected" : "draft"),
      enabled: sourceConfig.enabled ?? true,
      namespace: trimOrNull(sourceConfig.namespace) ?? input.sourceId,
      iconUrl: trimOrNull(sourceConfig.iconUrl) ?? null,
      bindingVersion: adapter.bindingConfigVersion,
      binding: sourceConfig.binding,
      importAuthPolicy: adapter.defaultImportAuthPolicy,
      importAuth: { kind: "none" },
      auth: sourceAuthFromConfigInput({
        auth: sourceConfig.connection.auth,
        config: input.loadedConfig.config,
        existing: null,
      }),
      sourceHash: existingState?.sourceHash ?? null,
      lastError: existingState?.lastError ?? null,
      createdAt: existingState?.createdAt ?? Date.now(),
      updatedAt: existingState?.updatedAt ?? Date.now(),
    })) as Source;

    const runtimeAuthArtifact = selectPreferredAuthArtifact({
      authArtifacts: input.authArtifacts.filter(
        (artifactItem) => artifactItem.sourceId === baseSource.id,
      ),
      actorAccountId: input.actorAccountId,
      slot: "runtime",
    });
    const importAuthArtifact = selectPreferredAuthArtifact({
      authArtifacts: input.authArtifacts.filter(
        (artifactItem) => artifactItem.sourceId === baseSource.id,
      ),
      actorAccountId: input.actorAccountId,
      slot: "import",
    });

    const source: Source = {
      ...baseSource,
      auth:
        runtimeAuthArtifact === null
          ? baseSource.auth
          : sourceAuthFromAuthArtifact(runtimeAuthArtifact),
      importAuth:
        baseSource.importAuthPolicy === "separate"
          ? importAuthArtifact === null
            ? baseSource.importAuth
            : sourceAuthFromAuthArtifact(importAuthArtifact)
          : { kind: "none" },
    };

    return {
      source,
      sourceId: input.sourceId,
    };
  });

export const loadSourcesInWorkspaceWithDeps = (
  deps: RuntimeSourceStoreDeps,
  workspaceId: WorkspaceId,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<
  readonly Source[],
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalFileSystemError
  | LocalExecutorConfigDecodeError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspaceFromDeps(
      deps,
      workspaceId,
    );
    const workspaceDatabase = makeWorkspaceDatabase(localWorkspace);
    const authArtifacts = yield* deps.rows.authArtifacts.listByWorkspaceId(
      workspaceId,
    );

    const sources = yield* Effect.forEach(
      Object.keys(localWorkspace.loadedConfig.config?.sources ?? {}),
      (sourceId) =>
        Effect.gen(function* () {
          const sid = SourceIdSchema.make(sourceId);
          const sourceStatus = yield* loadSourceStatus(sid).pipe(
            Effect.provide(workspaceDatabase.queryLayer()),
            Effect.catchAll(() => Effect.succeed(null)),
          );
          const { source } = yield* buildLocalSourceRecord({
            workspaceId,
            loadedConfig: localWorkspace.loadedConfig,
            sourceStatus,
            sourceId: sid,
            actorAccountId: options.actorAccountId,
            authArtifacts,
          });
          return source;
        }),
    );
    yield* Effect.annotateCurrentSpan("executor.source.count", sources.length);
    return sources;
  }).pipe(
    Effect.withSpan("source.store.load_workspace", {
      attributes: {
        "executor.workspace.id": workspaceId,
      },
    }),
  );


/**
 * Reconstruct a CatalogSnapshotV1 for a source by querying SQLite.
 *
 * Merges the symbol graph from catalog_revision.snapshot_json with
 * per-tool capability/executable JSON from catalog_tool rows.
 */
const loadSourceSnapshotFromSqlite = (
  source: Source,
): Effect.Effect<CatalogSnapshotV1 | null, unknown, SqliteDrizzle> =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;

    const catalogId = stableSourceCatalogId(source);

    // --- Load latest revision's snapshot_json ---
    const revisionRows = yield* db
      .select({
        snapshotJson: catalog_revision.snapshotJson,
        importMetadataJson: catalog_revision.importMetadataJson,
      })
      .from(catalog_revision)
      .where(eq(catalog_revision.catalogId, catalogId))
      .orderBy(desc(catalog_revision.revisionNumber))
      .limit(1);

    if (revisionRows.length === 0 || revisionRows[0].snapshotJson == null) {
      return null;
    }

    const snapshotData = typeof revisionRows[0].snapshotJson === "string"
      ? JSON.parse(revisionRows[0].snapshotJson)
      : revisionRows[0].snapshotJson;

    const importData = revisionRows[0].importMetadataJson != null
      ? (typeof revisionRows[0].importMetadataJson === "string"
        ? JSON.parse(revisionRows[0].importMetadataJson as string)
        : revisionRows[0].importMetadataJson)
      : { provenance: [], version: "ir.v1" };

    // --- Load capability + executable JSON from tool rows ---
    const toolRows = yield* db
      .select({
        capabilityJson: catalog_tool.capabilityJson,
        executableJson: catalog_tool.executableJson,
      })
      .from(catalog_tool)
      .where(
        and(
          eq(catalog_tool.sourceId, source.id),
          eq(catalog_tool.sourceEnabled, true),
          eq(catalog_tool.sourceStatus, "connected"),
        ),
      );

    const capabilities: Record<string, Capability> = {};
    const executables: Record<string, Executable> = {};

    for (const row of toolRows) {
      if (row.capabilityJson != null) {
        const capability: Capability = typeof row.capabilityJson === "string"
          ? JSON.parse(row.capabilityJson)
          : row.capabilityJson as Capability;
        capabilities[capability.id] = capability;

        // Also extract executables referenced by this capability
        if (row.executableJson != null) {
          const executable: Executable = typeof row.executableJson === "string"
            ? JSON.parse(row.executableJson)
            : row.executableJson as Executable;
          executables[executable.id] = executable;
        }
      }
    }

    const catalog: CatalogV1 = {
      version: "ir.v1",
      documents: {},
      resources: snapshotData.resources ?? {},
      scopes: snapshotData.scopes ?? {},
      symbols: snapshotData.symbols ?? {},
      capabilities,
      executables,
      responseSets: snapshotData.responseSets ?? {},
      diagnostics: snapshotData.diagnostics ?? {},
    };

    return {
      version: "ir.v1.snapshot",
      import: importData,
      catalog,
    } as CatalogSnapshotV1;
  });

export const syncWorkspaceSourceTypeDeclarationsWithDeps = (
  deps: RuntimeSourceStoreDeps,
  workspaceId: WorkspaceId,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspaceFromDeps(
      deps,
      workspaceId,
    );
    const workspaceDatabase = makeWorkspaceDatabase(localWorkspace);
    const sources = yield* loadSourcesInWorkspaceWithDeps(
      deps,
      workspaceId,
      options,
    );

    // Read snapshot data from SQLite instead of file artifacts
    const entries = yield* Effect.forEach(sources, (source) =>
      loadSourceSnapshotFromSqlite(source).pipe(
        Effect.provide(workspaceDatabase.queryLayer()),
        Effect.map((snapshot) =>
          snapshot === null
            ? null
            : { source, snapshot },
        ),
        Effect.catchAll(() => Effect.succeed(null)),
      ),
    );

    yield* Effect.sync(() => {
      refreshWorkspaceSourceTypeDeclarationsInBackground({
        context: localWorkspace.context,
        entries: entries.filter(
          (entry): entry is NonNullable<typeof entry> => entry !== null,
        ),
      });
    });
  }).pipe(
    Effect.withSpan("source.types.refresh_workspace.schedule", {
      attributes: {
        "executor.workspace.id": workspaceId,
      },
    }),
  );

export const shouldRefreshWorkspaceDeclarationsAfterPersist = (source: Source): boolean =>
  source.enabled === false ||
  source.status === "auth_required" ||
  source.status === "error" ||
  source.status === "draft";

export const listLinkedSecretSourcesInWorkspaceWithDeps = (
  deps: RuntimeSourceStoreDeps,
  workspaceId: WorkspaceId,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<
  Map<string, Array<{ sourceId: string; sourceName: string }>>,
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalFileSystemError
  | LocalExecutorConfigDecodeError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    const [sources, authArtifacts, materialIds] = yield* Effect.all([
      loadSourcesInWorkspaceWithDeps(deps, workspaceId, {
        actorAccountId: options.actorAccountId,
      }),
      deps.rows.authArtifacts.listByWorkspaceId(workspaceId),
      deps.rows.secretMaterials.listAll().pipe(
        Effect.map(
          (materials) => new Set(materials.map((material) => String(material.id))),
        ),
      ),
    ]);

    const sourceNames = new Map(
      sources.map((source) => [source.id, source.name] as const),
    );
    const linkedSources = new Map<
      string,
      Array<{ sourceId: string; sourceName: string }>
    >();

    for (const artifact of authArtifacts) {
      for (const ref of authArtifactSecretMaterialRefs(artifact)) {
        if (!materialIds.has(ref.handle)) {
          continue;
        }

        const existing = linkedSources.get(ref.handle) ?? [];
        if (!existing.some((link) => link.sourceId === artifact.sourceId)) {
          existing.push({
            sourceId: artifact.sourceId,
            sourceName: sourceNames.get(artifact.sourceId) ?? artifact.sourceId,
          });
          linkedSources.set(ref.handle, existing);
        }
      }
    }

    return linkedSources;
  });

export const loadSourceByIdWithDeps = (
  deps: RuntimeSourceStoreDeps,
  input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
  },
): Effect.Effect<
  Source,
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalFileSystemError
  | LocalExecutorConfigDecodeError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspaceFromDeps(
      deps,
      input.workspaceId,
    );
    const workspaceDatabase = makeWorkspaceDatabase(localWorkspace);
    const authArtifacts = yield* deps.rows.authArtifacts.listByWorkspaceId(
      input.workspaceId,
    );
    if (!localWorkspace.loadedConfig.config?.sources?.[input.sourceId]) {
      return yield* new LocalConfiguredSourceNotFoundError({
          message: `Source not found: workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
          sourceId: input.sourceId,
        });
    }

    const sourceStatus = yield* loadSourceStatus(input.sourceId).pipe(
      Effect.provide(workspaceDatabase.queryLayer()),
      Effect.catchAll(() => Effect.succeed(null)),
    );

    const localSource = yield* buildLocalSourceRecord({
      workspaceId: input.workspaceId,
      loadedConfig: localWorkspace.loadedConfig,
      sourceStatus,
      sourceId: input.sourceId,
      actorAccountId: input.actorAccountId,
      authArtifacts,
    });

    return localSource.source;
  }).pipe(
    Effect.withSpan("source.store.load_by_id", {
      attributes: {
        "executor.workspace.id": input.workspaceId,
        "executor.source.id": input.sourceId,
      },
    }),
  );
