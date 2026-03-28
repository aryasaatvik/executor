import { Schema } from "effect";

import {
  TimestampMsSchema,
  AccountIdSchema,
  ExecutionIdSchema,
  ExecutionInteractionIdSchema,
  ExecutionSessionIdSchema,
  ExecutionStepIdSchema,
  WorkspaceIdSchema,
} from "./ids";

export const ExecutionStatusSchema = Schema.Literal(
  "pending",
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "cancelled",
);

export const ExecutionRecordSchema = Schema.Struct({
  id: ExecutionIdSchema,
  workspaceId: WorkspaceIdSchema,
  createdByAccountId: AccountIdSchema,
  executionSessionId: Schema.NullOr(ExecutionSessionIdSchema),
  status: ExecutionStatusSchema,
  code: Schema.String,
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  logsJson: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(TimestampMsSchema),
  completedAt: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const ExecutionInteractionStatusSchema = Schema.Literal(
  "pending",
  "resolved",
  "cancelled",
);

export const ExecutionInteractionSchema = Schema.Struct({
  id: ExecutionInteractionIdSchema,
  executionId: ExecutionIdSchema,
  status: ExecutionInteractionStatusSchema,
  kind: Schema.String,
  purpose: Schema.String,
  payloadJson: Schema.String,
  responseJson: Schema.NullOr(Schema.String),
  responsePrivateJson: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const ExecutionEnvelopeSchema = Schema.Struct({
  execution: ExecutionRecordSchema,
  pendingInteraction: Schema.NullOr(ExecutionInteractionSchema),
});

export const ExecutionStepKindSchema = Schema.Literal("tool_call");

export const ExecutionStepStatusSchema = Schema.Literal(
  "pending",
  "waiting",
  "completed",
  "failed",
);

export const ExecutionStepSchema = Schema.Struct({
  id: ExecutionStepIdSchema,
  executionId: ExecutionIdSchema,
  sequence: Schema.Number,
  kind: ExecutionStepKindSchema,
  status: ExecutionStepStatusSchema,
  path: Schema.String,
  argsJson: Schema.String,
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  interactionId: Schema.NullOr(ExecutionInteractionIdSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type ExecutionStatus = typeof ExecutionStatusSchema.Type;
export type ExecutionRecord = typeof ExecutionRecordSchema.Type;
export type ExecutionInteractionStatus = typeof ExecutionInteractionStatusSchema.Type;
export type ExecutionInteraction = typeof ExecutionInteractionSchema.Type;
export type ExecutionEnvelope = typeof ExecutionEnvelopeSchema.Type;
export type ExecutionStepKind = typeof ExecutionStepKindSchema.Type;
export type ExecutionStepStatus = typeof ExecutionStepStatusSchema.Type;
export type ExecutionStep = typeof ExecutionStepSchema.Type;
