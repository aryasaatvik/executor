import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ExecutionId,
  ExecutionSessionId,
  WorkspaceId,
  AccountId,
  ExecutionRecord,
  ExecutionInteraction,
  ExecutionStep,
} from "../model/index";

// TODO: Migrate to ServiceMap.Service when moving to Effect v4

export interface ExecutionStoreShape {
  readonly create: (input: {
    workspaceId: WorkspaceId;
    accountId: AccountId;
    code: string;
    executionSessionId?: ExecutionSessionId | null;
  }) => Effect.Effect<ExecutionRecord, Error>;

  readonly getById: (input: {
    executionId: ExecutionId;
    workspaceId: WorkspaceId;
  }) => Effect.Effect<ExecutionRecord | null, Error>;

  readonly list: (input: {
    workspaceId: WorkspaceId;
  }) => Effect.Effect<ReadonlyArray<ExecutionRecord>, Error>;

  readonly update: (input: {
    executionId: ExecutionId;
    update: Partial<Pick<ExecutionRecord, "status" | "resultJson" | "errorText" | "logsJson" | "startedAt" | "completedAt">>;
  }) => Effect.Effect<ExecutionRecord, Error>;

  readonly createInteraction: (input: {
    executionId: ExecutionId;
    kind: string;
    purpose: string;
    payloadJson: string;
  }) => Effect.Effect<ExecutionInteraction, Error>;

  readonly getInteractionById: (input: {
    interactionId: string;
  }) => Effect.Effect<ExecutionInteraction | null, Error>;

  readonly resolveInteraction: (input: {
    interactionId: string;
    responseJson: string | null;
    responsePrivateJson?: string | null;
  }) => Effect.Effect<ExecutionInteraction, Error>;

  readonly getPendingInteraction: (input: {
    executionId: ExecutionId;
  }) => Effect.Effect<ExecutionInteraction | null, Error>;

  readonly createStep: (input: {
    executionId: ExecutionId;
    sequence: number;
    kind: "tool_call";
    path: string;
    argsJson: string;
  }) => Effect.Effect<ExecutionStep, Error>;

  readonly updateStep: (input: {
    stepId: string;
    update: Partial<Pick<ExecutionStep, "status" | "resultJson" | "errorText" | "interactionId">>;
  }) => Effect.Effect<ExecutionStep, Error>;

  readonly listSteps: (input: {
    executionId: ExecutionId;
  }) => Effect.Effect<ReadonlyArray<ExecutionStep>, Error>;
}

export class ExecutionStore extends Context.Tag(
  "@executor/core/ExecutionStore",
)<ExecutionStore, ExecutionStoreShape>() {}
