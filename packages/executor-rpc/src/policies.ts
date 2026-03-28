import * as Schema from "effect/Schema";
import {
  LocalWorkspacePolicyApprovalModeSchema,
  LocalWorkspacePolicyEffectSchema,
} from "@executor/core/model";
import { OptionalTrimmedNonEmptyStringSchema } from "./string-schemas";

const LocalWorkspacePolicyPayloadSchema = Schema.Struct({
  resourcePattern: OptionalTrimmedNonEmptyStringSchema,
  effect: Schema.optional(LocalWorkspacePolicyEffectSchema),
  approvalMode: Schema.optional(LocalWorkspacePolicyApprovalModeSchema),
  priority: Schema.optional(Schema.Number),
  enabled: Schema.optional(Schema.Boolean),
});

export const CreatePolicyPayloadSchema = LocalWorkspacePolicyPayloadSchema;
export const UpdatePolicyPayloadSchema = LocalWorkspacePolicyPayloadSchema;

export type CreatePolicyPayload = typeof CreatePolicyPayloadSchema.Type;
export type UpdatePolicyPayload = typeof UpdatePolicyPayloadSchema.Type;
