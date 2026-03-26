import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import {
  AccountIdSchema,
  ProviderAuthGrantIdSchema,
  WorkspaceIdSchema,
  WorkspaceOauthClientIdSchema,
} from "../ids";

import {
  OAuth2ClientAuthenticationMethodSchema,
  SecretRefSchema,
} from "./auth-artifact";

export const ProviderAuthGrantSchema = Schema.Struct({
  id: ProviderAuthGrantIdSchema,
  workspaceId: WorkspaceIdSchema,
  actorAccountId: Schema.NullOr(AccountIdSchema),
  providerKey: Schema.String,
  oauthClientId: WorkspaceOauthClientIdSchema,
  tokenEndpoint: Schema.String,
  clientAuthentication: OAuth2ClientAuthenticationMethodSchema,
  headerName: Schema.String,
  prefix: Schema.String,
  refreshToken: SecretRefSchema,
  grantedScopes: Schema.Array(Schema.String),
  lastRefreshedAt: Schema.NullOr(TimestampMsSchema),
  orphanedAt: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type ProviderAuthGrant = typeof ProviderAuthGrantSchema.Type;
