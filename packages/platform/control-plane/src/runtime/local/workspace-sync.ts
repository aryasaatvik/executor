import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { join } from "node:path";

import {
  type LoadedLocalExecutorConfig,
  type ResolvedLocalWorkspaceContext,
} from "./config";
import type {
  SourceCatalogId,
  SourceStatus,
  WorkspaceId,
} from "#schema";
import { SourceIdSchema } from "#schema";
import { EXECUTOR_DB_FILENAME } from "../../db/client.js";
import { makeWorkspaceCatalogDbLayer } from "../../db/setup";
import { catalog, source } from "../../db/schema";
import { removeSourceEmbeddings } from "../../db/embed-indexer";
import {
  listSourceLifecycles,
  removeSource,
  upsertSourceStatus,
} from "../../db/source-state";

const defaultLifecycleStatus = (input: {
  enabled: boolean;
  existingStatus?: SourceStatus | null;
}): SourceStatus => {
  if (!input.enabled) {
    return "draft";
  }

  switch (input.existingStatus) {
    case "connected":
    case "auth_required":
    case "error":
    case "probing":
      return input.existingStatus;
    default:
      return "connected";
  }
};

const cleanupOrphanCatalogs = (catalogIds: ReadonlyArray<SourceCatalogId>) =>
  Effect.gen(function* () {
    if (catalogIds.length === 0) {
      return;
    }

    const db = yield* SqliteDrizzle;
    for (const catalogId of new Set(catalogIds)) {
      const remainingRows = yield* db
        .select({ id: source.id })
        .from(source)
        .where(eq(source.catalogId, catalogId))
        .limit(1);

      if (remainingRows.length > 0) {
        continue;
      }

      yield* db.delete(catalog).where(eq(catalog.id, catalogId));
    }
  });

export const synchronizeLocalWorkspaceState = (input: {
  context: ResolvedLocalWorkspaceContext;
  workspaceId: WorkspaceId;
  loadedConfig: LoadedLocalExecutorConfig;
}): Effect.Effect<LoadedLocalExecutorConfig["config"], unknown, never> =>
  Effect.gen(function* () {
    const configuredSources = input.loadedConfig.config?.sources ?? {};
    const configuredSourceIds = new Set(Object.keys(configuredSources));
    const workspaceDbPath = join(input.context.stateDirectory, EXECUTOR_DB_FILENAME);
    const now = Date.now();

    yield* Effect.gen(function* () {
      const existingRows = yield* listSourceLifecycles(input.workspaceId);
      const existingById = new Map(
        existingRows.map((row) => [row.sourceId, row] as const),
      );

      for (const [sourceIdText, configuredSource] of Object.entries(configuredSources)) {
        const sourceId = SourceIdSchema.make(sourceIdText);
        const existing = existingById.get(sourceId);
        const enabled = configuredSource.enabled ?? true;
        const status = defaultLifecycleStatus({
          enabled,
          existingStatus: existing?.status ?? null,
        });
        const changed =
          existing === undefined
          || existing.enabled !== enabled
          || existing.status !== status;

        yield* upsertSourceStatus({
          sourceId,
          workspaceId: input.workspaceId,
          catalogId: existing?.catalogId ?? null,
          catalogRevisionId: existing?.catalogRevisionId ?? null,
          status,
          enabled,
          lastError: existing?.lastError ?? null,
          sourceHash: existing?.sourceHash ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: changed ? now : (existing?.updatedAt ?? now),
        });
      }

      const removedRows = existingRows.filter((row) =>
        !configuredSourceIds.has(row.sourceId)
      );

      for (const removedRow of removedRows) {
        yield* removeSourceEmbeddings(removedRow.sourceId);
        yield* removeSource(removedRow.sourceId);
      }

      yield* cleanupOrphanCatalogs(
        removedRows
          .map((row) => row.catalogId)
          .filter((catalogId): catalogId is SourceCatalogId => catalogId !== null),
      );
    }).pipe(
      Effect.provide(makeWorkspaceCatalogDbLayer(workspaceDbPath)),
    );

    return input.loadedConfig.config;
  });
