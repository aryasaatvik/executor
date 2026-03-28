// API payload types — copied from @executor/engine/src/api/sources/api.ts and policies/api.ts
import * as Schema from "effect/Schema";

import {
  SourceKindSchema,
  SourceStatusSchema,
  SourceAuthSchema,
  SourceImportAuthPolicySchema,
  JsonObjectSchema,
  LocalWorkspacePolicyEffectSchema,
  LocalWorkspacePolicyApprovalModeSchema,
} from "../../model/index";

const TrimmedNonEmptyStringSchema = Schema.String.pipe(
  Schema.trimmed(),
  Schema.nonEmptyString(),
);

const OptionalTrimmedNonEmptyStringSchema = Schema.optional(
  TrimmedNonEmptyStringSchema,
);

// --- Source payloads ---

const createSourcePayloadRequiredSchema = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  kind: SourceKindSchema,
  endpoint: TrimmedNonEmptyStringSchema,
});

const createSourcePayloadOptionalSchema = Schema.Struct({
  status: Schema.optional(SourceStatusSchema),
  enabled: Schema.optional(Schema.Boolean),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  iconUrl: Schema.optional(Schema.NullOr(Schema.String)),
  binding: Schema.optional(JsonObjectSchema),
  importAuthPolicy: Schema.optional(SourceImportAuthPolicySchema),
  importAuth: Schema.optional(SourceAuthSchema),
  auth: Schema.optional(SourceAuthSchema),
  sourceHash: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
});

export const CreateSourcePayloadSchema = Schema.extend(
  createSourcePayloadRequiredSchema,
  createSourcePayloadOptionalSchema,
);

export type CreateSourcePayload = typeof CreateSourcePayloadSchema.Type;

export const UpdateSourcePayloadSchema = Schema.Struct({
  name: OptionalTrimmedNonEmptyStringSchema,
  endpoint: OptionalTrimmedNonEmptyStringSchema,
  status: Schema.optional(SourceStatusSchema),
  enabled: Schema.optional(Schema.Boolean),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  iconUrl: Schema.optional(Schema.NullOr(Schema.String)),
  binding: Schema.optional(JsonObjectSchema),
  importAuthPolicy: Schema.optional(SourceImportAuthPolicySchema),
  importAuth: Schema.optional(SourceAuthSchema),
  auth: Schema.optional(SourceAuthSchema),
  sourceHash: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
});

export type UpdateSourcePayload = typeof UpdateSourcePayloadSchema.Type;

// --- Policy payloads ---

const LocalWorkspacePolicyPayloadSchema = Schema.Struct({
  resourcePattern: OptionalTrimmedNonEmptyStringSchema,
  effect: Schema.optional(LocalWorkspacePolicyEffectSchema),
  approvalMode: Schema.optional(LocalWorkspacePolicyApprovalModeSchema),
  priority: Schema.optional(Schema.Number),
  enabled: Schema.optional(Schema.Boolean),
});

export const CreatePolicyPayloadSchema = LocalWorkspacePolicyPayloadSchema;

export type CreatePolicyPayload = typeof CreatePolicyPayloadSchema.Type;

export const UpdatePolicyPayloadSchema = LocalWorkspacePolicyPayloadSchema;

export type UpdatePolicyPayload = typeof UpdatePolicyPayloadSchema.Type;
