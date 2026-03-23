import type {
  AccountId,
  Source,
  WorkspaceId,
} from "#schema";
import * as Effect from "effect/Effect";

import { RuntimeLocalWorkspaceService } from "../../local/runtime-context";
import { SourceArtifactStore } from "../../local/storage";
import { getSourceAdapterForSource } from "../../sources/source-adapters";
import { RuntimeSourceStoreService } from "../../sources/source-store";
import { RuntimeSourceCatalogSyncService } from "./sync";

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
  | SourceArtifactStore
  | RuntimeSourceStoreService
  | RuntimeSourceCatalogSyncService
> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const sourceStore = yield* RuntimeSourceStoreService;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceCatalogSync = yield* RuntimeSourceCatalogSyncService;
    const sources = yield* sourceStore.loadSourcesInWorkspace(input.workspaceId, {
      actorAccountId: input.actorAccountId,
    });

    for (const source of sources) {
      if (!shouldReconcileSource(source)) {
        continue;
      }

      const artifact = yield* sourceArtifactStore.read({
        context: runtimeLocalWorkspace.context,
        sourceId: source.id,
      });
      if (artifact !== null) {
        continue;
      }

      yield* sourceCatalogSync.sync({
        source,
        actorAccountId: input.actorAccountId,
      });
    }
  }).pipe(
    Effect.withSpan("source.catalog.reconcile_missing", {
      attributes: {
        "executor.workspace.id": input.workspaceId,
      },
    }),
  );
