import * as Schema from "effect/Schema";
import {
  ExecutionSessionIdSchema,
} from "@executor/core/model";
import { TrimmedNonEmptyStringSchema } from "./string-schemas";

export const CreateExecutionPayloadSchema = Schema.Struct({
  code: TrimmedNonEmptyStringSchema,
  executionSessionId: Schema.optional(ExecutionSessionIdSchema),
  interactionMode: Schema.optional(Schema.Literal("live", "live_form", "detach")),
});

export const ResumeExecutionPayloadSchema = Schema.Struct({
  responseJson: Schema.optional(Schema.String),
  interactionMode: Schema.optional(Schema.Literal("live", "live_form", "detach")),
});

export type CreateExecutionPayload = typeof CreateExecutionPayloadSchema.Type;
export type ResumeExecutionPayload = typeof ResumeExecutionPayloadSchema.Type;
