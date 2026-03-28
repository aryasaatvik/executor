import * as Schema from "effect/Schema";
import {
  LocalConfigSemanticSearchSchema,
  SecretMaterialPurposeSchema,
} from "@executor/core/model";

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

export const UpdateInstanceConfigPayloadSchema = Schema.Struct({
  semanticSearch: Schema.NullOr(LocalConfigSemanticSearchSchema),
});

export const SecretLinkedSourceSchema = Schema.Struct({
  sourceId: Schema.String,
  sourceName: Schema.String,
});

export const SecretListItemSchema = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  name: Schema.NullOr(Schema.String),
  purpose: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  linkedSources: Schema.Array(SecretLinkedSourceSchema),
});

export const CreateSecretPayloadSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  purpose: Schema.optional(SecretMaterialPurposeSchema),
  providerId: Schema.optional(Schema.String),
});

export const CreateSecretResultSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  providerId: Schema.String,
  purpose: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const UpdateSecretPayloadSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
});

export const UpdateSecretResultSchema = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  name: Schema.NullOr(Schema.String),
  purpose: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const DeleteSecretResultSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export type SecretProvider = typeof SecretProviderSchema.Type;
export type InstanceConfig = typeof InstanceConfigSchema.Type;
export type UpdateInstanceConfigPayload = typeof UpdateInstanceConfigPayloadSchema.Type;
export type SecretLinkedSource = typeof SecretLinkedSourceSchema.Type;
export type SecretListItem = typeof SecretListItemSchema.Type;
export type CreateSecretPayload = typeof CreateSecretPayloadSchema.Type;
export type CreateSecretResult = typeof CreateSecretResultSchema.Type;
export type UpdateSecretPayload = typeof UpdateSecretPayloadSchema.Type;
export type UpdateSecretResult = typeof UpdateSecretResultSchema.Type;
export type DeleteSecretResult = typeof DeleteSecretResultSchema.Type;
