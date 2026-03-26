import type {
  AccountId,
  Source,
  SourceStatus,
  WorkspaceId,
} from "#schema";
import * as Effect from "effect/Effect";
import { isSourceCredentialRequiredError } from "@executor/source-core";

import { WorkspaceDatabase } from "../../local/workspace-database";
import { getSourceAdapterForSource } from "../../sources/source-adapters";
import {
  stableSourceCatalogId,
  stableSourceCatalogRevisionId,
} from "../../sources/source-definitions";
import { SourceStore } from "../../sources/source-store";
import { SourceCatalogSync } from "./sync";
import { hasSourceCatalogData } from "../../../db/indexer";
import { loadSourceLifecycle } from "../../../db/source-state";


const shouldReconcileSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected"
  && getSourceAdapterForSource(source).catalogKind !== "internal";

const updateReconciledSourceStatus = (input: {
  sourceStore: Effect.Effect.Success<typeof SourceStore>;
  source: Source;
  actorAccountId?: AccountId | null;
  status: SourceStatus;
  lastError: string | null;
}) =>
  Effect.gen(function* () {
    const latest = yield* input.sourceStore.loadSourceById({
      workspaceId: input.source.workspaceId,
      sourceId: input.source.id,
      actorAccountId: input.actorAccountId,
    });

    return yield* input.sourceStore.persistSource({
      ...latest,
      status: input.status,
      lastError: input.lastError,
      updatedAt: Date.now(),
    }, {
      actorAccountId: input.actorAccountId,
    });
  }).pipe(Effect.catchAll(() => Effect.void));

export const reconcileMissingSourceCatalogArtifacts = (input: {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
}): Effect.Effect<
  void,
  Error,
  | WorkspaceDatabase
  | SourceStore
  | SourceCatalogSync
> =>
  Effect.gen(function* () {
    const workspaceDatabase = yield* WorkspaceDatabase;
    const sourceStore = yield* SourceStore;
    const sourceCatalogSync = yield* SourceCatalogSync;
    const sources = yield* sourceStore.loadSourcesInWorkspace(input.workspaceId, {
      actorAccountId: input.actorAccountId,
    });

    for (const source of sources) {
      if (!shouldReconcileSource(source)) {
        continue;
      }

      const lifecycle = yield* workspaceDatabase.provideQuery(
        loadSourceLifecycle(source.id),
      ).pipe(Effect.catchAll(() => Effect.succeed(null)));
      const hasCatalog = yield* workspaceDatabase.provideQuery(
        hasSourceCatalogData(source.id),
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));
      const expectedCatalogId = stableSourceCatalogId(source);
      const expectedCatalogRevisionId = stableSourceCatalogRevisionId(source);
      const hasCurrentCatalog =
        hasCatalog
        && lifecycle !== null
        && lifecycle.catalogId === expectedCatalogId
        && lifecycle.catalogRevisionId === expectedCatalogRevisionId;

      if (hasCurrentCatalog) {
        continue;
      }

      yield* sourceCatalogSync.sync({
        source,
        actorAccountId: input.actorAccountId,
      }).pipe(
        Effect.catchAll((error) => {
          const message = error instanceof Error ? error.message : String(error);
          const nextStatus: SourceStatus = isSourceCredentialRequiredError(error)
            ? "auth_required"
            : "error";
          const lastError = nextStatus === "auth_required" ? null : message;

          return updateReconciledSourceStatus({
            sourceStore,
            source,
            actorAccountId: input.actorAccountId,
            status: nextStatus,
            lastError,
          }).pipe(
            Effect.zipRight(
              Effect.logWarning(
                `Failed reconciling source catalog for ${source.id}: ${message}`,
              ),
            ),
            Effect.asVoid,
          );
        }),
      );
    }
  }).pipe(
    Effect.withSpan("source.catalog.reconcile_missing", {
      attributes: {
        "executor.workspace.id": input.workspaceId,
      },
    }),
  );
