import type {
  AccountId,
  Source,
  WorkspaceId,
} from "#schema";
import * as Effect from "effect/Effect";

import { RuntimeLocalWorkspace } from "../../local/runtime-context";
import { WorkspaceDatabase } from "../../local/workspace-database";
import { getSourceAdapterForSource } from "../../sources/source-adapters";
import { SourceStore } from "../../sources/source-store";
import { SourceCatalogSync } from "./sync";
import { hasSourceCatalogData } from "../../../db/indexer";


const shouldReconcileSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected"
  && getSourceAdapterForSource(source).catalogKind !== "internal";

export const reconcileMissingSourceCatalogArtifacts = (input: {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
}): Effect.Effect<
  void,
  Error,
  | RuntimeLocalWorkspace
  | WorkspaceDatabase
  | SourceStore
  | SourceCatalogSync
> =>
  Effect.gen(function* () {
    yield* RuntimeLocalWorkspace;
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

      const hasCatalog = yield* workspaceDatabase.provideWrite(
        hasSourceCatalogData(source.id),
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (hasCatalog) {
        continue;
      }

      yield* sourceCatalogSync.sync({
        source,
        actorAccountId: input.actorAccountId,
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(
            `Failed reconciling source catalog for ${source.id}: ${error instanceof Error ? error.message : String(error)}`,
          ).pipe(Effect.asVoid),
        ),
      );
    }
  }).pipe(
    Effect.withSpan("source.catalog.reconcile_missing", {
      attributes: {
        "executor.workspace.id": input.workspaceId,
      },
    }),
  );
