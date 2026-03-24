import { Schema } from "effect";

import { TimestampMsSchema } from "../../common";
import { AccountIdSchema } from "../../ids";
import { PrincipalProviderSchema } from "./principal";

export const AccountSchema = Schema.Struct({
  id: AccountIdSchema,
  provider: PrincipalProviderSchema,
  subject: Schema.String,
  email: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const AccountInsertSchema = AccountSchema;

export const AccountUpdateSchema = Schema.partial(
  Schema.Struct({
    provider: PrincipalProviderSchema,
    subject: Schema.String,
    email: Schema.NullOr(Schema.String),
    displayName: Schema.NullOr(Schema.String),
    updatedAt: TimestampMsSchema,
  }),
);

export type Account = typeof AccountSchema.Type;
