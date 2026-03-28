import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  ExecutionIdSchema,
  ExecutionEnvelopeSchema,
  ExecutionRecordSchema,
  ExecutionSessionIdSchema,
  ExecutionStepSchema,
  WorkspaceIdSchema,
} from "@executor/core/model";
import * as Schema from "effect/Schema";

import {
  EngineBadRequestError,
  EngineForbiddenError,
  EngineNotFoundError,
  EngineStorageError,
  EngineUnauthorizedError,
} from "../errors";
import { TrimmedNonEmptyStringSchema } from "../string-schemas";

export const CreateExecutionPayloadSchema = Schema.Struct({
  code: TrimmedNonEmptyStringSchema,
  executionSessionId: Schema.optional(ExecutionSessionIdSchema),
  interactionMode: Schema.optional(Schema.Literal("live", "live_form", "detach")),
});

export type CreateExecutionPayload = typeof CreateExecutionPayloadSchema.Type;

export const ResumeExecutionPayloadSchema = Schema.Struct({
  responseJson: Schema.optional(Schema.String),
  interactionMode: Schema.optional(Schema.Literal("live", "live_form", "detach")),
});

export type ResumeExecutionPayload = typeof ResumeExecutionPayloadSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const executionIdParam = HttpApiSchema.param("executionId", ExecutionIdSchema);
const executionSessionIdParam = HttpApiSchema.param(
  "executionSessionId",
  ExecutionSessionIdSchema,
);

export class ExecutionsApi extends HttpApiGroup.make("executions")
  .add(
    HttpApiEndpoint.post("create")`/workspaces/${workspaceIdParam}/executions`
      .setPayload(CreateExecutionPayloadSchema)
      .addSuccess(ExecutionEnvelopeSchema)
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.get("get")`/workspaces/${workspaceIdParam}/executions/${executionIdParam}`
      .addSuccess(ExecutionEnvelopeSchema)
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.post("resume")`/workspaces/${workspaceIdParam}/executions/${executionIdParam}/resume`
      .setPayload(ResumeExecutionPayloadSchema)
      .addSuccess(ExecutionEnvelopeSchema)
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.get("list")`/workspaces/${workspaceIdParam}/executions`
      .addSuccess(Schema.Array(ExecutionRecordSchema))
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.get("listSteps")`/workspaces/${workspaceIdParam}/executions/${executionIdParam}/steps`
      .addSuccess(Schema.Array(ExecutionStepSchema))
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineNotFoundError)
      .addError(EngineStorageError),
  )
  .add(
    HttpApiEndpoint.del("closeSession")`/workspaces/${workspaceIdParam}/execution-sessions/${executionSessionIdParam}`
      .addSuccess(Schema.Struct({ closed: Schema.Boolean }))
      .addError(EngineBadRequestError)
      .addError(EngineUnauthorizedError)
      .addError(EngineForbiddenError)
      .addError(EngineStorageError),
  )
  .prefix("/v1") {}
