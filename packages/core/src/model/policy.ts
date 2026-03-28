import { Schema } from "effect";

import { TimestampMsSchema, PolicyIdSchema, WorkspaceIdSchema } from "./ids";

export const PolicyEffectSchema = Schema.Literal("allow", "deny");
export const PolicyApprovalModeSchema = Schema.Literal("auto", "required");

export const PolicySchema = Schema.Struct({
  id: PolicyIdSchema,
  slug: Schema.String,
  workspaceId: WorkspaceIdSchema,
  resourcePattern: Schema.String,
  effect: PolicyEffectSchema,
  approvalMode: PolicyApprovalModeSchema,
  priority: Schema.Number,
  enabled: Schema.Boolean,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type PolicyEffect = typeof PolicyEffectSchema.Type;
export type PolicyApprovalMode = typeof PolicyApprovalModeSchema.Type;
export type Policy = typeof PolicySchema.Type;

// ---------------------------------------------------------------------------
// LocalWorkspacePolicy
// ---------------------------------------------------------------------------

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
