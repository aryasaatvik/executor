import * as Schema from "effect/Schema";
import {
  JsonObjectSchema,
  ProviderAuthGrantIdSchema,
  SourceAuthSchema,
  SourceAuthSessionIdSchema,
  SourceDiscoveryResultSchema,
  SourceIdSchema,
  SourceImportAuthPolicySchema,
  SourceKindSchema,
  SourceOauthClientInputSchema,
  SourceProbeAuthSchema,
  SourceSchema,
  SourceStatusSchema,
  WorkspaceOauthClientIdSchema,
  WorkspaceOauthClientSchema,
} from "@executor/core/model";
import {
  ConnectSourcePayloadSchema,
  type ConnectSourcePayload,
} from "@executor/core/services/engine/source-adapters";
import { OptionalTrimmedNonEmptyStringSchema, TrimmedNonEmptyStringSchema } from "./string-schemas";

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

export const CreateWorkspaceOauthClientPayloadSchema = Schema.Struct({
  providerKey: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  oauthClient: SourceOauthClientInputSchema,
});

const ConnectGoogleDiscoveryBatchSourceSchema = Schema.Struct({
  service: TrimmedNonEmptyStringSchema,
  version: TrimmedNonEmptyStringSchema,
  discoveryUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  scopes: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ConnectSourceBatchPayloadSchema = Schema.Struct({
  workspaceOauthClientId: WorkspaceOauthClientIdSchema,
  sources: Schema.Array(ConnectGoogleDiscoveryBatchSourceSchema),
});

export const ConnectSourceBatchResultSchema = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      source: SourceSchema,
      status: Schema.Literal("connected", "pending_oauth"),
    }),
  ),
  providerOauthSession: Schema.NullOr(
    Schema.Struct({
      sessionId: SourceAuthSessionIdSchema,
      authorizationUrl: Schema.String,
      sourceIds: Schema.Array(SourceIdSchema),
    }),
  ),
});

export const DiscoverSourcePayloadSchema = Schema.Struct({
  url: TrimmedNonEmptyStringSchema,
  probeAuth: Schema.optional(SourceProbeAuthSchema),
});

export const ConnectSourceResultSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("connected"),
    source: SourceSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("credential_required"),
    source: SourceSchema,
    credentialSlot: Schema.Literal("runtime", "import"),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth_required"),
    source: SourceSchema,
    sessionId: SourceAuthSessionIdSchema,
    authorizationUrl: Schema.String,
  }),
);

export type CreateSourcePayload = typeof CreateSourcePayloadSchema.Type;
export type UpdateSourcePayload = typeof UpdateSourcePayloadSchema.Type;
export type CreateWorkspaceOauthClientPayload =
  typeof CreateWorkspaceOauthClientPayloadSchema.Type;
export type DiscoverSourcePayload = typeof DiscoverSourcePayloadSchema.Type;
export type ConnectSourceResult = typeof ConnectSourceResultSchema.Type;
export type ConnectSourceBatchPayload = typeof ConnectSourceBatchPayloadSchema.Type;
export type ConnectSourceBatchResult = typeof ConnectSourceBatchResultSchema.Type;
export type { ConnectSourcePayload };
export {
  ConnectSourcePayloadSchema,
  ProviderAuthGrantIdSchema,
  WorkspaceOauthClientIdSchema,
  WorkspaceOauthClientSchema,
};
