import * as Schema from "effect/Schema";

import {
  AccountIdSchema,
  WorkspaceIdSchema,
} from "../ids";

export const LocalInstallationSchema = Schema.Struct({
  accountId: AccountIdSchema,
  workspaceId: WorkspaceIdSchema,
});

export const LocalInstallationInsertSchema = LocalInstallationSchema;
export const LocalInstallationUpdateSchema = Schema.partial(LocalInstallationSchema);

export type LocalInstallation = typeof LocalInstallationSchema.Type;
