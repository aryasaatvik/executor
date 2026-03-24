import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import {
  WorkspaceIdSchema,
  WorkspaceOauthClientIdSchema,
} from "../ids";

export const WorkspaceOauthClientSchema = Schema.Struct({
  id: WorkspaceOauthClientIdSchema,
  workspaceId: WorkspaceIdSchema,
  providerKey: Schema.String,
  label: Schema.NullOr(Schema.String),
  clientId: Schema.String,
  clientSecretProviderId: Schema.NullOr(Schema.String),
  clientSecretHandle: Schema.NullOr(Schema.String),
  clientMetadataJson: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type WorkspaceOauthClient = typeof WorkspaceOauthClientSchema.Type;
