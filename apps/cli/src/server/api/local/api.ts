import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  LocalConfigSemanticSearchSchema,
  SecretMaterialPurposeSchema,
} from "@executor/core/model";
import { LocalInstallationSchema } from "@executor/world-local";
import * as Schema from "effect/Schema";

import {
  EngineBadRequestError,
  EngineNotFoundError,
  EngineStorageError,
} from "../errors";

export const SecretProviderSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  canStore: Schema.Boolean,
});

export const InstanceConfigSchema = Schema.Struct({
  platform: Schema.String,
  secretProviders: Schema.Array(SecretProviderSchema),
  defaultSecretStoreProvider: Schema.String,
  semanticSearch: Schema.NullOr(LocalConfigSemanticSearchSchema),
});

export type SecretProvider = typeof SecretProviderSchema.Type;
export type InstanceConfig = typeof InstanceConfigSchema.Type;

export const UpdateInstanceConfigPayloadSchema = Schema.Struct({
  semanticSearch: Schema.NullOr(LocalConfigSemanticSearchSchema),
});

export type UpdateInstanceConfigPayload =
  typeof UpdateInstanceConfigPayloadSchema.Type;
export type UpdateInstanceConfigResult = InstanceConfig;

// -- Secrets CRUD schemas ---------------------------------------------------

export const SecretLinkedSourceSchema = Schema.Struct({
  sourceId: Schema.String,
  sourceName: Schema.String,
});

export type SecretLinkedSource = typeof SecretLinkedSourceSchema.Type;

export const SecretListItemSchema = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  name: Schema.NullOr(Schema.String),
  purpose: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  linkedSources: Schema.Array(SecretLinkedSourceSchema),
});

export type SecretListItem = typeof SecretListItemSchema.Type;

export const CreateSecretPayloadSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  purpose: Schema.optional(SecretMaterialPurposeSchema),
  providerId: Schema.optional(Schema.String),
});

export type CreateSecretPayload = typeof CreateSecretPayloadSchema.Type;

export const CreateSecretResultSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  providerId: Schema.String,
  purpose: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export type CreateSecretResult = typeof CreateSecretResultSchema.Type;

export const UpdateSecretPayloadSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
});

export type UpdateSecretPayload = typeof UpdateSecretPayloadSchema.Type;

export const UpdateSecretResultSchema = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  name: Schema.NullOr(Schema.String),
  purpose: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export type UpdateSecretResult = typeof UpdateSecretResultSchema.Type;

export const DeleteSecretResultSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export type DeleteSecretResult = typeof DeleteSecretResultSchema.Type;

// -- API group --------------------------------------------------------------

export class LocalApi extends HttpApiGroup.make("local")
  .add(
    HttpApiEndpoint.get("installation")`/local/installation`
      .addSuccess(LocalInstallationSchema)
      .addError(EngineBadRequestError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.get("config")`/local/config`
      .addSuccess(InstanceConfigSchema)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.patch("updateConfig")`/local/config`
      .setPayload(UpdateInstanceConfigPayloadSchema)
      .addSuccess(InstanceConfigSchema)
      .addError(EngineBadRequestError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.get("listSecrets")`/local/secrets`
      .addSuccess(Schema.Array(SecretListItemSchema))
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.post("createSecret")`/local/secrets`
      .setPayload(CreateSecretPayloadSchema)
      .addSuccess(CreateSecretResultSchema)
      .addError(EngineBadRequestError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.patch("updateSecret")`/local/secrets/${HttpApiSchema.param("secretId", Schema.String)}`
      .setPayload(UpdateSecretPayloadSchema)
      .addSuccess(UpdateSecretResultSchema)
      .addError(EngineBadRequestError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.del("deleteSecret")`/local/secrets/${HttpApiSchema.param("secretId", Schema.String)}`
      .addSuccess(DeleteSecretResultSchema)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .prefix("/v1") {}
