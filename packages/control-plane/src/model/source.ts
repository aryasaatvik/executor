import { Schema } from "effect";
import {
  SourceImportAuthPolicySchema,
  SourceTransportSchema,
  StringMapSchema,
} from "@executor/source-core";

import {
  TimestampMsSchema,
  SourceIdSchema,
  SourceCatalogIdSchema,
  SourceCatalogRevisionIdSchema,
  ProviderAuthGrantIdSchema,
  WorkspaceIdSchema,
} from "./ids";
import { SecretRefSchema, JsonObjectSchema } from "./auth";

export const SourceKindSchema = Schema.String;

export const SourceStatusSchema = Schema.Literal(
  "draft",
  "probing",
  "auth_required",
  "connected",
  "error",
);

export const SourceAuthSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("bearer"),
    headerName: Schema.String,
    prefix: Schema.String,
    token: SecretRefSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    headerName: Schema.String,
    prefix: Schema.String,
    accessToken: SecretRefSchema,
    refreshToken: Schema.NullOr(SecretRefSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2_authorized_user"),
    headerName: Schema.String,
    prefix: Schema.String,
    tokenEndpoint: Schema.String,
    clientId: Schema.String,
    clientAuthentication: Schema.Literal("none", "client_secret_post"),
    clientSecret: Schema.NullOr(SecretRefSchema),
    refreshToken: SecretRefSchema,
    grantSet: Schema.NullOr(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("provider_grant_ref"),
    grantId: ProviderAuthGrantIdSchema,
    providerKey: Schema.String,
    requiredScopes: Schema.Array(Schema.String),
    headerName: Schema.String,
    prefix: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp_oauth"),
    redirectUri: Schema.String,
    accessToken: SecretRefSchema,
    refreshToken: Schema.NullOr(SecretRefSchema),
    tokenType: Schema.String,
    expiresIn: Schema.NullOr(Schema.Number),
    scope: Schema.NullOr(Schema.String),
    resourceMetadataUrl: Schema.NullOr(Schema.String),
    authorizationServerUrl: Schema.NullOr(Schema.String),
    resourceMetadataJson: Schema.NullOr(Schema.String),
    authorizationServerMetadataJson: Schema.NullOr(Schema.String),
    clientInformationJson: Schema.NullOr(Schema.String),
  }),
);

export const SourceBindingVersionSchema = Schema.Number;

export const SourceBindingSchema = Schema.Struct({
  version: SourceBindingVersionSchema,
  payload: JsonObjectSchema,
});

export const SourceSchema = Schema.Struct({
  id: SourceIdSchema,
  workspaceId: WorkspaceIdSchema,
  name: Schema.String,
  kind: SourceKindSchema,
  endpoint: Schema.String,
  status: SourceStatusSchema,
  enabled: Schema.Boolean,
  namespace: Schema.NullOr(Schema.String),
  iconUrl: Schema.NullOr(Schema.String),
  bindingVersion: SourceBindingVersionSchema,
  binding: JsonObjectSchema,
  importAuthPolicy: SourceImportAuthPolicySchema,
  importAuth: SourceAuthSchema,
  auth: SourceAuthSchema,
  sourceHash: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const SourceDefinitionSnapshotSchema = Schema.Struct({
  id: SourceIdSchema,
  workspaceId: WorkspaceIdSchema,
  catalogId: SourceCatalogIdSchema,
  catalogRevisionId: SourceCatalogRevisionIdSchema,
  name: Schema.String,
  kind: SourceKindSchema,
  endpoint: Schema.String,
  status: SourceStatusSchema,
  enabled: Schema.Boolean,
  namespace: Schema.NullOr(Schema.String),
  iconUrl: Schema.NullOr(Schema.String),
  importAuthPolicy: SourceImportAuthPolicySchema,
  bindingConfigJson: Schema.String,
  sourceHash: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export { SourceImportAuthPolicySchema, SourceTransportSchema, StringMapSchema };

export type SourceKind = typeof SourceKindSchema.Type;
export type SourceStatus = typeof SourceStatusSchema.Type;
export type SourceTransport = typeof SourceTransportSchema.Type;
export type SourceImportAuthPolicy = typeof SourceImportAuthPolicySchema.Type;
export type SourceAuth = typeof SourceAuthSchema.Type;
export type SourceBinding = typeof SourceBindingSchema.Type;
export type SourceDefinitionSnapshot = typeof SourceDefinitionSnapshotSchema.Type;
export type StringMap = typeof StringMapSchema.Type;
export type Source = typeof SourceSchema.Type;
