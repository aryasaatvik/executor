import {
  HttpApiBuilder,
} from "@effect/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { SecretMaterialIdSchema } from "@executor/core/model";
import { requireRuntimeLocalWorkspace } from "@executor/core/services/engine/runtime-context";
import { WorkspaceConfigStore } from "@executor/core/services/engine/local-storage";
import {
  SecretMaterialStore as ControlPlaneSecretMaterialStore,
} from "@executor/core/services/engine/secret-material-store";
import {
  SourceStore,
} from "@executor/core/services/sources/source-service";
import {
  ENV_SECRET_PROVIDER_ID,
  KEYCHAIN_SECRET_PROVIDER_ID,
  LOCAL_SECRET_PROVIDER_ID,
  parseSecretStoreProviderId,
  resolveDefaultSecretStoreProviderId,
} from "@executor/world-local";
import type {
  CreateSecretResult,
  InstanceConfig,
  SecretProvider,
  UpdateInstanceConfigPayload,
  UpdateSecretResult,
} from "./api";
import { validateSemanticSearchConfigForWrite } from "./semantic-search-config";

import { EngineApi } from "../api";
import {
  EngineBadRequestError,
  EngineNotFoundError,
  EngineStorageError,
} from "../errors";

const SECRET_STORE_PROVIDER_ENV = "EXECUTOR_SECRET_STORE_PROVIDER";
const getInstanceConfig = (
  semanticSearch: InstanceConfig["semanticSearch"],
): Effect.Effect<InstanceConfig> => {
  const explicitDefaultStoreProvider =
    parseSecretStoreProviderId(process.env[SECRET_STORE_PROVIDER_ENV]);
  const providers: SecretProvider[] = [
    {
      id: LOCAL_SECRET_PROVIDER_ID,
      name: "Local store",
      canStore: true,
    },
  ];

  if (process.platform === "darwin" || process.platform === "linux") {
    providers.push({
      id: KEYCHAIN_SECRET_PROVIDER_ID,
      name: process.platform === "darwin" ? "macOS Keychain" : "Desktop Keyring",
      canStore:
        process.platform === "darwin"
        || explicitDefaultStoreProvider === KEYCHAIN_SECRET_PROVIDER_ID,
    });
  }

  providers.push({
    id: ENV_SECRET_PROVIDER_ID,
    name: "Environment variable",
    canStore: false,
  });

  return resolveDefaultSecretStoreProviderId({
    storeProviderId: explicitDefaultStoreProvider ?? undefined,
  }).pipe(
    Effect.map((resolvedDefaultStoreProvider) => ({
      platform: process.platform,
      secretProviders: providers,
      defaultSecretStoreProvider: resolvedDefaultStoreProvider,
      semanticSearch,
    })),
  );
};

const storageError = (operation: string, message: string) =>
  new EngineStorageError({
    operation,
    message,
    details: message,
  });

const getLocalInstallation = () =>
  requireRuntimeLocalWorkspace().pipe(
    Effect.map((runtimeLocalWorkspace) => runtimeLocalWorkspace.installation),
    Effect.mapError((cause) =>
      storageError(
        "local.installation",
        cause instanceof Error
          ? cause.message
          : "Failed resolving local installation.",
      ),
    ),
  );

const loadInstanceConfig = () =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace().pipe(
      Effect.mapError(() =>
        storageError("local.config", "Failed resolving local workspace."),
      ),
    );
    const workspaceConfigStore = yield* WorkspaceConfigStore;
    const loadedConfig = yield* workspaceConfigStore.load(
      runtimeLocalWorkspace.context,
    ).pipe(
      Effect.mapError((cause) =>
        storageError(
          "local.config",
          cause instanceof Error
            ? cause.message
            : "Failed loading local config.",
        ),
      ),
    );

    return yield* getInstanceConfig(loadedConfig.config?.semanticSearch ?? null);
  });

const writeInstanceConfig = (
  payload: UpdateInstanceConfigPayload,
) =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace().pipe(
      Effect.mapError(() =>
        storageError("local.config.update", "Failed resolving local workspace."),
      ),
    );
    const workspaceConfigStore = yield* WorkspaceConfigStore;
    const loadedConfig = yield* workspaceConfigStore.load(
      runtimeLocalWorkspace.context,
    ).pipe(
      Effect.mapError((cause) =>
        storageError(
          "local.config.update",
          cause instanceof Error
            ? cause.message
            : "Failed loading local config.",
        ),
      ),
    );

    const semanticSearchValidationError = validateSemanticSearchConfigForWrite(
      payload.semanticSearch,
    );
    if (semanticSearchValidationError) {
      return yield* new EngineBadRequestError({
        operation: "local.config.update",
        message: semanticSearchValidationError,
        details: semanticSearchValidationError,
      });
    }

    const currentProjectConfig = loadedConfig.projectConfig ?? {};
    const nextProjectConfig = {
      ...currentProjectConfig,
      semanticSearch: payload.semanticSearch,
    };

    yield* workspaceConfigStore.writeProject({
      context: runtimeLocalWorkspace.context,
      config: nextProjectConfig,
    }).pipe(
      Effect.mapError((cause) =>
        storageError(
          "local.config.update",
          cause instanceof Error
            ? cause.message
            : "Failed writing local config.",
        ),
      ),
    );

    return yield* loadInstanceConfig();
  });

export const EngineLocalLive = HttpApiBuilder.group(
  EngineApi,
  "local",
  (handlers) =>
    handlers
      .handle("installation", () =>
        getLocalInstallation(),
      )
      .handle("config", () =>
        loadInstanceConfig(),
      )
      .handle("updateConfig", ({ payload }) =>
        writeInstanceConfig(payload),
      )
        .handle("listSecrets", () =>
          Effect.gen(function* () {
            const secretMaterialStore = yield* ControlPlaneSecretMaterialStore;
            const sourceStore = yield* SourceStore;
            const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace().pipe(
              Effect.mapError(() =>
                storageError("secrets", "Failed resolving local workspace."),
              ),
            );
            const rows = yield* secretMaterialStore.listAll().pipe(
              Effect.mapError(() =>
                storageError("secrets", "Failed listing secrets."),
              ),
            );
            const linkedSourcesMap = yield* sourceStore.listLinkedSecretSourcesInWorkspace(
              runtimeLocalWorkspace.installation.workspaceId,
              {
                actorAccountId: runtimeLocalWorkspace.installation.accountId,
              },
            ).pipe(
              Effect.mapError(() =>
                storageError("secrets", "Failed loading linked sources."),
              ),
            );
            return rows.map((row) => ({
              ...row,
              linkedSources: linkedSourcesMap.get(row.id) ?? [],
            }));
          }),
      )
      .handle("createSecret", ({ payload }) =>
        Effect.gen(function* () {
          const name = payload.name.trim();
          const value = payload.value;
          const purpose = payload.purpose ?? "auth_material";
          const requestedProviderId = payload.providerId === undefined
            ? null
            : parseSecretStoreProviderId(payload.providerId);

          if (name.length === 0) {
            return yield* new EngineBadRequestError({
                operation: "secrets.create",
                message: "Secret name is required.",
                details: "Secret name is required.",
              });
          }
          if (payload.providerId !== undefined && requestedProviderId === null) {
            return yield* new EngineBadRequestError({
                operation: "secrets.create",
                message: `Unsupported secret provider: ${payload.providerId}`,
                details: `Unsupported secret provider: ${payload.providerId}`,
              });
          }

          const secretMaterialStore = yield* ControlPlaneSecretMaterialStore;
          const ref = yield* secretMaterialStore.store({
            name,
            purpose,
            value,
            ...(requestedProviderId ? { providerId: requestedProviderId } : {}),
          }).pipe(
            Effect.mapError((cause) => storageError(
              "secrets.create",
              cause instanceof Error ? cause.message : "Failed creating secret.",
            )),
          );
          const secretId = SecretMaterialIdSchema.make(ref.handle);
          const created = yield* secretMaterialStore.getById(secretId).pipe(
            Effect.mapError(() =>
              storageError("secrets.create", "Failed loading created secret."),
            ),
          );

          if (Option.isNone(created)) {
            return yield* storageError(
              "secrets.create",
              `Created secret not found: ${ref.handle}`,
            );
          }

          return {
            id: created.value.id,
            name: created.value.name,
            providerId: created.value.providerId,
            purpose: created.value.purpose,
            createdAt: created.value.createdAt,
            updatedAt: created.value.updatedAt,
          } satisfies CreateSecretResult;
        }),
      )
      .handle("updateSecret", ({ path, payload }) =>
        Effect.gen(function* () {
          const secretId = SecretMaterialIdSchema.make(path.secretId);
          const secretMaterialStore = yield* ControlPlaneSecretMaterialStore;

          const existing = yield* secretMaterialStore.getById(secretId).pipe(
            Effect.mapError(() =>
              storageError("secrets.update", "Failed looking up secret."),
            ),
          );

          if (Option.isNone(existing)) {
            return yield* new EngineNotFoundError({
                operation: "secrets.update",
                message: `Secret not found: ${path.secretId}`,
                details: `Secret not found: ${path.secretId}`,
              });
          }

          const update: { name?: string | null; value?: string } = {};
          if (payload.name !== undefined) update.name = payload.name.trim() || null;
          if (payload.value !== undefined) update.value = payload.value;

          const updated = yield* secretMaterialStore.update({
            ref: {
              providerId: existing.value.providerId,
              handle: existing.value.id,
            },
            ...update,
          }).pipe(
            Effect.mapError(() =>
              storageError("secrets.update", "Failed updating secret."),
            ),
          );

          return {
            id: updated.id,
            providerId: updated.providerId,
            name: updated.name,
            purpose: updated.purpose,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
          } satisfies UpdateSecretResult;
        }),
      )
      .handle("deleteSecret", ({ path }) =>
        Effect.gen(function* () {
          const secretId = SecretMaterialIdSchema.make(path.secretId);
          const secretMaterialStore = yield* ControlPlaneSecretMaterialStore;

          const existing = yield* secretMaterialStore.getById(secretId).pipe(
            Effect.mapError(() =>
              storageError("secrets.delete", "Failed looking up secret."),
            ),
          );

          if (Option.isNone(existing)) {
            return yield* new EngineNotFoundError({
                operation: "secrets.delete",
                message: `Secret not found: ${path.secretId}`,
                details: `Secret not found: ${path.secretId}`,
              });
          }

          const removed = yield* secretMaterialStore.remove({
            providerId: existing.value.providerId,
            handle: existing.value.id,
          }).pipe(
            Effect.mapError(() =>
              storageError("secrets.delete", "Failed removing secret."),
            ),
          );

          if (!removed) {
            return yield* storageError(
              "secrets.delete",
              `Failed removing secret: ${path.secretId}`,
            );
          }

          return { removed: true };
        }),
      ),
);
