import { createHash } from "node:crypto";

import {
  AccountIdSchema,
  WorkspaceIdSchema,
} from "@executor/control-plane/model";
import type { AccountId, WorkspaceId } from "@executor/control-plane/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ResolvedLocalWorkspaceContext } from "./config";

export type LocalInstallation = {
  accountId: AccountId;
  workspaceId: WorkspaceId;
};

export const LocalInstallationSchema = Schema.Struct({
  accountId: AccountIdSchema,
  workspaceId: WorkspaceIdSchema,
});

const LOCAL_ACCOUNT_ID = AccountIdSchema.make("acc_local_default");

const stableHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const normalizeSlashPath = (value: string): string =>
  value.replaceAll("\\", "/");

const deriveWorkspaceId = (context: ResolvedLocalWorkspaceContext) =>
  WorkspaceIdSchema.make(
    `ws_local_${stableHash(normalizeSlashPath(context.workspaceRoot))}`,
  );

export const deriveLocalInstallation = (
  context: ResolvedLocalWorkspaceContext,
): LocalInstallation => ({
  accountId: LOCAL_ACCOUNT_ID,
  workspaceId: deriveWorkspaceId(context),
});

export const loadLocalInstallation = (
  context: ResolvedLocalWorkspaceContext,
): Effect.Effect<LocalInstallation, never> =>
  Effect.succeed(deriveLocalInstallation(context));

export const getOrProvisionLocalInstallation = (input: {
  context: ResolvedLocalWorkspaceContext;
}): Effect.Effect<LocalInstallation, never> =>
  loadLocalInstallation(input.context);
