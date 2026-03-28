import { randomUUID } from "node:crypto";
import type {
  AccountId,
  Source,
  SourceId,
  WorkspaceId,
} from "../../model";
import { SourceIdSchema } from "../../model";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";

import type {
  CreateSourcePayload,
  UpdateSourcePayload,
} from "../engine/payload-types";
import {
  createSourceFromPayload,
  updateSourceFromPayload,
} from "./source-definitions";
import { getSourceAdapterForSource } from "../engine/source-adapters";
import { mapPersistenceError } from "../policy/operations-shared";
import { operationErrors } from "../policy/operation-errors";
import { EngineStore, type EngineStoreShape } from "../engine/store";
import { SourceCatalogSync } from "../catalog/catalog-sync";
import { SourceStore } from "./source-service";

const sourceOps = {
  create: operationErrors("sources.create"),
  update: operationErrors("sources.update"),
} as const;

const shouldAutoProbeSource = (source: Source): boolean =>
  getSourceAdapterForSource(source).shouldAutoProbe(source);

const syncArtifactsForSource = (input: {
  store: EngineStoreShape;
  sourceStore: Effect.Effect.Success<typeof SourceStore>;
  source: Source;
  actorAccountId: AccountId;
  operation:
    | typeof sourceOps.create
    | typeof sourceOps.update;
}) =>
  Effect.gen(function* () {
    const catalogSyncService = yield* SourceCatalogSync;

    const autoProbe = shouldAutoProbeSource(input.source);
    const sourceForSync = autoProbe
      ? { ...input.source, status: "connected" as const }
      : input.source;

    const synced = yield* Effect.either(
      catalogSyncService.sync({
        source: sourceForSync,
        actorAccountId: input.actorAccountId,
      }),
    );

    return yield* Either.match(synced, {
      onRight: () =>
        Effect.gen(function* () {
          if (autoProbe) {
            const connectedSource = yield* updateSourceFromPayload({
              source: input.source,
              payload: { status: "connected", lastError: null },
              now: Date.now(),
            }).pipe(
              Effect.mapError((cause) =>
                input.operation.badRequest(
                  "Failed updating source status",
                  cause instanceof Error ? cause.message : String(cause),
                ),
              ),
            );
            yield* mapPersistenceError(
              input.operation.child("source_connected"),
              input.sourceStore.persistSource(connectedSource, {
                actorAccountId: input.actorAccountId,
              }),
            );
            return connectedSource;
          }

          return input.source;
        }),
      onLeft: (error) =>
        Effect.gen(function* () {
          if (autoProbe || (input.source.enabled && input.source.status === "connected")) {
            const erroredSource = yield* updateSourceFromPayload({
              source: input.source,
              payload: {
                status: "error",
                lastError: error.message,
              },
              now: Date.now(),
            }).pipe(
              Effect.mapError((cause) =>
                input.operation.badRequest(
                  "Failed indexing source tools",
                  cause instanceof Error ? cause.message : String(cause),
                ),
              ),
            );

            yield* mapPersistenceError(
              input.operation.child("source_error"),
              input.sourceStore.persistSource(erroredSource, {
                actorAccountId: input.actorAccountId,
              }),
            );
          }

          return yield* input.operation.unknownStorage(
            error,
            "Failed syncing source tools",
          );
        }),
    });
  });

export const createSource = (input: {
  workspaceId: WorkspaceId;
  accountId: AccountId;
  payload: CreateSourcePayload;
}) =>
  Effect.flatMap(EngineStore, (store) =>
    Effect.gen(function* () {
      const sourceStore = yield* SourceStore;
      const now = Date.now();

      const source = yield* createSourceFromPayload({
        workspaceId: input.workspaceId,
        sourceId: SourceIdSchema.make(`src_${randomUUID()}`),
        payload: input.payload,
        now,
      }).pipe(
        Effect.mapError((cause) =>
          sourceOps.create.badRequest(
            "Invalid source definition",
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
      );

      const persistedSource = yield* mapPersistenceError(
        sourceOps.create.child("persist"),
        sourceStore.persistSource(source, {
          actorAccountId: input.accountId,
        }),
      );

      return yield* syncArtifactsForSource({
        store,
        sourceStore,
        source: persistedSource,
        actorAccountId: input.accountId,
        operation: sourceOps.create,
      });
    }),
  );

export const updateSource = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  accountId: AccountId;
  payload: UpdateSourcePayload;
}) =>
  Effect.flatMap(EngineStore, (store) =>
    Effect.gen(function* () {
      const sourceStore = yield* SourceStore;
      const existingSource = yield* sourceStore.loadSourceById({
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        actorAccountId: input.accountId,
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error && cause.message.startsWith("Source not found:")
            ? sourceOps.update.notFound(
                "Source not found",
                `workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
              )
            : sourceOps.update.unknownStorage(
                cause,
                "Failed projecting stored source",
              ),
        ),
      );

      const updatedSource = yield* updateSourceFromPayload({
        source: existingSource,
        payload: input.payload,
        now: Date.now(),
      }).pipe(
        Effect.mapError((cause) =>
          sourceOps.update.badRequest(
            "Invalid source definition",
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
      );

      const persistedSource = yield* mapPersistenceError(
        sourceOps.update.child("persist"),
        sourceStore.persistSource(updatedSource, {
          actorAccountId: input.accountId,
        }),
      );

      return yield* syncArtifactsForSource({
        store,
        sourceStore,
        source: persistedSource,
        actorAccountId: input.accountId,
        operation: sourceOps.update,
      });
    }),
  );
