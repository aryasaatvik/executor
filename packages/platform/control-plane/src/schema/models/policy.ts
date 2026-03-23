import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { PolicyIdSchema, WorkspaceIdSchema } from "../ids";

export const LocalWorkspacePolicyEffectSchema = Schema.Literal("allow", "deny");
export const LocalWorkspacePolicyApprovalModeSchema = Schema.Literal("auto", "required");

export const LocalWorkspacePolicySchema = Schema.Struct({
  id: PolicyIdSchema,
  slug: Schema.String,
  workspaceId: WorkspaceIdSchema,
  resourcePattern: Schema.String,
  effect: LocalWorkspacePolicyEffectSchema,
  approvalMode: LocalWorkspacePolicyApprovalModeSchema,
  priority: Schema.Number,
  enabled: Schema.Boolean,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const LocalWorkspacePolicyInsertSchema = LocalWorkspacePolicySchema;
export const LocalWorkspacePolicyUpdateSchema = Schema.partial(LocalWorkspacePolicySchema);

export type LocalWorkspacePolicyEffect = typeof LocalWorkspacePolicyEffectSchema.Type;
export type LocalWorkspacePolicyApprovalMode =
  typeof LocalWorkspacePolicyApprovalModeSchema.Type;
export type LocalWorkspacePolicy = typeof LocalWorkspacePolicySchema.Type;
