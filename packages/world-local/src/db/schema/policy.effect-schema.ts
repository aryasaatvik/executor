import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-orm/effect-schema";

import {
  PolicyApprovalModeSchema,
  PolicyEffectSchema,
  PolicyIdSchema,
  TimestampMsSchema,
  WorkspaceIdSchema,
} from "@executor/core/model";

import { policy } from "./policy.sql";

const policySchemaRefinements = {
  id: PolicyIdSchema,
  workspaceId: WorkspaceIdSchema,
  effect: PolicyEffectSchema,
  approvalMode: PolicyApprovalModeSchema,
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
