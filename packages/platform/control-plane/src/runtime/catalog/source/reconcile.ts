import { EXECUTOR_DB_FILENAME } from "../../../db/client.js"
import type {
  AccountId,
  Source,
  WorkspaceId,
} from "#schema";
import * as Effect from "effect/Effect";
import { join } from "node:path";

import { RuntimeLocalWorkspaceService } from "../../local/runtime-context";
import { getSourceAdapterForSource } from "../../sources/source-adapters";
import { RuntimeSourceStoreService } from "../../sources/source-store";
import { RuntimeSourceCatalogSyncService } from "./sync";
import { makeWorkspaceCatalogDbLayer } from "../../../db/setup";
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
  | RuntimeLocalWorkspaceService
  | RuntimeSourceStoreService
  | RuntimeSourceCatalogSyncService
> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const sourceStore = yield* RuntimeSourceStoreService;
    const sourceCatalogSync = yield* RuntimeSourceCatalogSyncService;
    const sources = yield* sourceStore.loadSourcesInWorkspace(input.workspaceId, {
      actorAccountId: input.actorAccountId,
    });

    const dbPath = join(
      runtimeLocalWorkspace.context.stateDirectory,
      EXECUTOR_DB_FILENAME,
    );
    const dbLayer = makeWorkspaceCatalogDbLayer(dbPath);

    for (const source of sources) {
      if (!shouldReconcileSource(source)) {
        continue;
      }

      const hasCatalog = yield* hasSourceCatalogData(source.id).pipe(
        Effect.provide(dbLayer),
        Effect.catchAll(() => Effect.succeed(false)),
      );
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
