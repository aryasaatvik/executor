import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-orm/effect-schema";

import {
  LocalWorkspacePolicyApprovalModeSchema,
  LocalWorkspacePolicyEffectSchema,
  PolicyIdSchema,
  TimestampMsSchema,
  WorkspaceIdSchema,
} from "#schema";

import { policy } from "./policy.sql";

const policySchemaRefinements = {
  id: PolicyIdSchema,
  workspaceId: WorkspaceIdSchema,
  effect: LocalWorkspacePolicyEffectSchema,
  approvalMode: LocalWorkspacePolicyApprovalModeSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const PolicySelectSchema = createSelectSchema(
  policy,
  policySchemaRefinements,
);

export const PolicyInsertSchema = createInsertSchema(
  policy,
  policySchemaRefinements,
);

export const PolicyUpdateSchema = createUpdateSchema(
  policy,
  policySchemaRefinements,
);
