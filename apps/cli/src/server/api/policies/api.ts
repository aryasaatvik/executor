import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  PolicyIdSchema,
  WorkspaceIdSchema,
  LocalWorkspacePolicyApprovalModeSchema,
  LocalWorkspacePolicyEffectSchema,
  LocalWorkspacePolicySchema,
} from "@executor/control-plane/model";
import * as Schema from "effect/Schema";

import {
  EngineBadRequestError,
  EngineForbiddenError,
  EngineNotFoundError,
  EngineStorageError,
  EngineUnauthorizedError,
} from "../errors";
import { OptionalTrimmedNonEmptyStringSchema } from "../string-schemas";

const LocalWorkspacePolicyPayloadSchema = Schema.Struct({
  resourcePattern: OptionalTrimmedNonEmptyStringSchema,
  effect: Schema.optional(LocalWorkspacePolicyEffectSchema),
  approvalMode: Schema.optional(LocalWorkspacePolicyApprovalModeSchema),
  priority: Schema.optional(Schema.Number),
  enabled: Schema.optional(Schema.Boolean),
});

export const CreatePolicyPayloadSchema = LocalWorkspacePolicyPayloadSchema;

export type CreatePolicyPayload = typeof CreatePolicyPayloadSchema.Type;

export const UpdatePolicyPayloadSchema = LocalWorkspacePolicyPayloadSchema;

export type UpdatePolicyPayload = typeof UpdatePolicyPayloadSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const policyIdParam = HttpApiSchema.param("policyId", PolicyIdSchema);

export class PoliciesApi extends HttpApiGroup.make("policies")
  .add(
    HttpApiEndpoint.get("list")`/workspaces/${workspaceIdParam}/policies`
      .addSuccess(Schema.Array(LocalWorkspacePolicySchema))
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.post("create")`/workspaces/${workspaceIdParam}/policies`
      .setPayload(CreatePolicyPayloadSchema)
      .addSuccess(LocalWorkspacePolicySchema)
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.get("get")`/workspaces/${workspaceIdParam}/policies/${policyIdParam}`
      .addSuccess(LocalWorkspacePolicySchema)
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.patch("update")`/workspaces/${workspaceIdParam}/policies/${policyIdParam}`
      .setPayload(UpdatePolicyPayloadSchema)
      .addSuccess(LocalWorkspacePolicySchema)
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.del("remove")`/workspaces/${workspaceIdParam}/policies/${policyIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .prefix("/v1") {}
