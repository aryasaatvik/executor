import { randomUUID } from "node:crypto";
import {
  ExecutionIdSchema,
  ExecutionInteractionIdSchema,
  ExecutionStepIdSchema,
  type ExecutionId,
  type ExecutionInteraction,
  type ExecutionRecord,
  type ExecutionStep,
} from "@executor/control-plane/model";
import type { ExecutionStoreShape } from "@executor/control-plane/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { LocalEngineStore } from "./engine-store";

const executionNotFound = (executionId: string) =>
  new Error(`Execution not found: ${executionId}`);

const interactionNotFound = (interactionId: string) =>
  new Error(`Interaction not found: ${interactionId}`);

const stepNotFound = (stepId: string) =>
  new Error(`Execution step not found: ${stepId}`);

const fromOption = <A>(
  option: Option.Option<A>,
  onNone: () => Error,
): Effect.Effect<A, Error, never> =>
  Option.isSome(option)
    ? Effect.succeed(option.value)
    : Effect.fail(onNone());

export const createSqliteExecutionStore = (
  rows?: LocalEngineStore,
): ExecutionStoreShape => {
  if (!rows) {
    return {
      create: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store create")),
      getById: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store getById")),
      list: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store list")),
      update: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store update")),
      createInteraction: (_input) =>
        Effect.fail(new Error("TODO: implement sqlite execution store createInteraction")),
      getInteractionById: (_input) =>
        Effect.fail(new Error("TODO: implement sqlite execution store getInteractionById")),
      resolveInteraction: (_input) =>
        Effect.fail(new Error("TODO: implement sqlite execution store resolveInteraction")),
      getPendingInteraction: (_input) =>
        Effect.fail(new Error("TODO: implement sqlite execution store getPendingInteraction")),
      createStep: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store createStep")),
      updateStep: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store updateStep")),
      listSteps: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store listSteps")),
    };
  }

  const knownExecutionIds = new Set<ExecutionId>();
  const stepIndex = new Map<string, { executionId: ExecutionId; sequence: number }>();

  const rememberExecution = (execution: Pick<ExecutionRecord, "id">) => {
    knownExecutionIds.add(execution.id);
  };

  const rememberSteps = (steps: ReadonlyArray<ExecutionStep>) => {
    for (const step of steps) {
      knownExecutionIds.add(step.executionId);
      stepIndex.set(step.id, {
        executionId: step.executionId,
        sequence: step.sequence,
      });
    }
  };

  const resolveStepLocation = (
    stepId: string,
  ): Effect.Effect<{ executionId: ExecutionId; sequence: number }, Error, never> =>
    Effect.gen(function* () {
      const cached = stepIndex.get(stepId);
      if (cached) {
        return cached;
      }

      for (const executionId of knownExecutionIds) {
        const steps = yield* rows.executionSteps.listByExecutionId(executionId);
        rememberSteps(steps);
        const found = stepIndex.get(stepId);
        if (found) {
          return found;
        }
      }

      return yield* Effect.fail(stepNotFound(stepId));
    });

  return {
    create: (input) =>
      Effect.gen(function* () {
        const now = Date.now();
        const record: ExecutionRecord = {
          id: ExecutionIdSchema.make(`exec_${randomUUID()}`),
          workspaceId: input.workspaceId,
          createdByAccountId: input.accountId,
          executionSessionId: input.executionSessionId ?? null,
          status: "pending",
          code: input.code,
          resultJson: null,
          errorText: null,
          logsJson: null,
          startedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        };

        yield* rows.executions.insert(record);
        rememberExecution(record);
        return record;
      }),

    getById: (input) =>
      rows.executions
        .getByWorkspaceAndId(input.workspaceId, input.executionId)
        .pipe(
          Effect.map((option) => {
            if (Option.isSome(option)) {
              rememberExecution(option.value);
              return option.value;
            }
            return null;
          }),
        ),

    list: (input) =>
      rows.executions.listByWorkspaceId(input.workspaceId).pipe(
        Effect.map((executions) => {
          for (const execution of executions) {
            rememberExecution(execution);
          }
          return executions;
        }),
      ),

    update: (input) =>
      rows.executions
        .update(input.executionId, {
          ...input.update,
          updatedAt: Date.now(),
        })
        .pipe(
          Effect.flatMap((option) =>
            fromOption(option, () => executionNotFound(input.executionId)),
          ),
          Effect.tap((execution) => Effect.sync(() => rememberExecution(execution))),
        ),

    createInteraction: (input) =>
      Effect.gen(function* () {
        const now = Date.now();
        const interaction: ExecutionInteraction = {
          id: ExecutionInteractionIdSchema.make(`intr_${randomUUID()}`),
          executionId: input.executionId,
          status: "pending",
          kind: input.kind,
          purpose: input.purpose,
          payloadJson: input.payloadJson,
          responseJson: null,
          responsePrivateJson: null,
          createdAt: now,
          updatedAt: now,
        };

        yield* rows.executionInteractions.insert(interaction);
        return interaction;
      }),

    getInteractionById: (input) =>
      rows.executionInteractions
        .getById(ExecutionInteractionIdSchema.make(input.interactionId))
        .pipe(
        Effect.map((option) => (Option.isSome(option) ? option.value : null)),
      ),

    resolveInteraction: (input) =>
      rows.executionInteractions
        .update(ExecutionInteractionIdSchema.make(input.interactionId), {
          status: "resolved",
          responseJson: input.responseJson,
          responsePrivateJson: input.responsePrivateJson ?? null,
          updatedAt: Date.now(),
        })
        .pipe(
          Effect.flatMap((option) =>
            fromOption(option, () => interactionNotFound(input.interactionId)),
          ),
        ),

    getPendingInteraction: (input) =>
      rows.executionInteractions.getPendingByExecutionId(input.executionId).pipe(
        Effect.map((option) => (Option.isSome(option) ? option.value : null)),
      ),

    createStep: (input) =>
      Effect.gen(function* () {
        const now = Date.now();
        const step: ExecutionStep = {
          id: ExecutionStepIdSchema.make(`step_${randomUUID()}`),
          executionId: input.executionId,
          sequence: input.sequence,
          kind: input.kind,
          status: "pending",
          path: input.path,
          argsJson: input.argsJson,
          resultJson: null,
          errorText: null,
          interactionId: null,
          createdAt: now,
          updatedAt: now,
        };

        yield* rows.executionSteps.insert(step);
        rememberSteps([step]);
        return step;
      }),

    updateStep: (input) =>
      Effect.gen(function* () {
        const location = yield* resolveStepLocation(input.stepId);
        const updated = yield* rows.executionSteps.updateByExecutionAndSequence(
          location.executionId,
          location.sequence,
          {
            ...input.update,
            updatedAt: Date.now(),
          },
        ).pipe(
          Effect.flatMap((option) =>
            fromOption(option, () => stepNotFound(input.stepId)),
          ),
        );

        rememberSteps([updated]);
        return updated;
      }),

    listSteps: (input) =>
      rows.executionSteps.listByExecutionId(input.executionId).pipe(
        Effect.map((steps) => {
          rememberSteps(steps);
          return steps;
        }),
      ),
  };
};
