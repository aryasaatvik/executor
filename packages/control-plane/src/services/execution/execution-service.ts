// TODO: Many imports still reference @executor/engine internals.
// These should be replaced as services migrate to control-plane.

import { clearMcpConnectionPoolSession } from "@executor/source-mcp";
import type {
  ElicitationResponse,
  OnElicitation,
  ToolInvocationContext,
  ToolInvoker,
} from "@executor/codemode-core";
import {
  ExecutionIdSchema,
  type AccountId,
  type ExecutionId,
  type ExecutionEnvelope,
  type ExecutionRecord,
  type ExecutionInteraction,
  type WorkspaceId,
  type ExecutionSessionId,
} from "../../model/index";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type ResolveExecutionEnvironment } from "./execution-state";
import {
  ExecutionManager,
  sanitizePersistedElicitationResponse,
  type LiveExecutionManager,
} from "./execution-manager";
import { runtimeEffectError } from "./effect-errors";
import { ExecutionEnvironmentResolver } from "./environment-resolver";

// TODO: These engine-internal imports should be replaced with control-plane
// port interfaces and services as they are migrated.
import { ExecutionStore, type ExecutionStoreShape } from "../../ports/execution-store";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

// Local reimplementation of engine's RuntimeLocalWorkspace utilities
// (not re-exported from @executor/engine)
type RuntimeLocalWorkspaceState = {
  context: unknown;
  installation: { workspaceId: WorkspaceId; accountId: AccountId };
  loadedConfig: unknown;
};

class RuntimeLocalWorkspace extends Context.Tag(
  "#runtime/RuntimeLocalWorkspace",
)<RuntimeLocalWorkspace, RuntimeLocalWorkspaceState>() {}

const provideOptionalRuntimeLocalWorkspace = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null | undefined,
): Effect.Effect<A, E, R> =>
  runtimeLocalWorkspace === null || runtimeLocalWorkspace === undefined
    ? effect
    : effect.pipe(Effect.provide(Layer.succeed(RuntimeLocalWorkspace, runtimeLocalWorkspace)));

const getRuntimeLocalWorkspaceOption = () =>
  Effect.contextWith((context: Context.Context<never>) =>
    Context.getOption(context, RuntimeLocalWorkspace),
  ).pipe(
    Effect.map((option) => (Option.isSome(option) ? option.value : null)),
  ) as Effect.Effect<RuntimeLocalWorkspaceState | null, never, never>;

// Local payload type definitions (engine API types not accessible via exports)
type CreateExecutionPayload = {
  code: string;
  executionSessionId?: ExecutionSessionId;
  interactionMode?: "live" | "live_form" | "detach";
};

type ResumeExecutionPayload = {
  responseJson?: string;
  interactionMode?: "live" | "live_form" | "detach";
};

// Local operation error helpers (engine-internal, not re-exported)
type OperationErrors = {
  readonly operation: string;
  readonly child: (suffix: string) => OperationErrors;
  readonly badRequest: (message: string, details: string) => Error;
  readonly notFound: (message: string, details: string) => Error;
  readonly storage: (error: Error) => Error;
  readonly mapStorage: <A, E extends Error>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, Error>;
};

type OperationErrorsLike = OperationErrors | string;

const operationErrors = (operation: string): OperationErrors => {
  const self: OperationErrors = {
    operation,
    child: (suffix: string) => operationErrors(`${operation}.${suffix}`),
    badRequest: (message: string, details: string) =>
      new Error(`[${operation}] ${message}: ${details}`),
    notFound: (message: string, details: string) =>
      new Error(`[${operation}] Not found: ${message} (${details})`),
    storage: (error: Error) =>
      new Error(`[${operation}] Storage error: ${error.message}`),
    mapStorage: <A, E extends Error>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError((error) => self.storage(error))),
  };
  return self;
};

const asOperationErrors = (
  errors: OperationErrorsLike,
): OperationErrors =>
  typeof errors === "string" ? operationErrors(errors) : errors;

const executionOps = {
  create: operationErrors("executions.create"),
  get: operationErrors("executions.get"),
  list: operationErrors("executions.list"),
  listSteps: operationErrors("executions.listSteps"),
  resume: operationErrors("executions.resume"),
} as const;

type InteractionMode = NonNullable<CreateExecutionPayload["interactionMode"]>;

const EXECUTION_SUSPENDED_SENTINEL = "__EXECUTION_SUSPENDED__";

const DEFAULT_INTERACTION_MODE: InteractionMode = "detach";

const serializeJson = (value: unknown): string | null => {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
};

const serializeRequiredJson = (value: unknown): string =>
  JSON.stringify(value === undefined ? null : value);

const parseStoredJson = (value: string | null): unknown => {
  if (value === null) {
    return undefined;
  }

  return JSON.parse(value);
};

const ElicitationActionSchema = Schema.Literal("accept", "decline", "cancel");

const ElicitationResponseSchema = Schema.Struct({
  action: ElicitationActionSchema,
  content: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
  ),
});

const decodeElicitationResponse = Schema.decodeUnknown(ElicitationResponseSchema);

const withExecutionInvocationContext = (input: {
  executionId: ExecutionRecord["id"];
  executionSessionId: ExecutionRecord["executionSessionId"];
  actorAccountId: ExecutionRecord["createdByAccountId"];
  toolInvoker: ToolInvoker;
}): ToolInvoker => {
  let sequence = 0;

  return {
    invoke: ({ path, args, context }) => {
      sequence += 1;

      return input.toolInvoker.invoke({
        path,
        args,
        context: {
          ...context,
          runId: input.executionId,
          executionSessionId: input.executionSessionId ?? undefined,
          actor: input.actorAccountId,
          callId:
            typeof context?.callId === "string" && context.callId.length > 0
              ? context.callId
              : `call_${String(sequence)}`,
          executionStepSequence: sequence,
        },
      });
    },
  };
};

const executionStepSequenceFromContext = (
  context: ToolInvocationContext | undefined,
): number | null => {
  const value = context?.executionStepSequence;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
};

const resolveInteractionMode = (
  value: CreateExecutionPayload["interactionMode"] | ResumeExecutionPayload["interactionMode"],
): InteractionMode =>
  value === "live" || value === "live_form" ? value : DEFAULT_INTERACTION_MODE;

class ExecutionSuspendedError extends Data.TaggedError(
  "ExecutionSuspendedError",
)<{
  readonly executionId: ExecutionRecord["id"];
  readonly interactionId: string;
  readonly message: string;
}> {}

const createExecutionSuspendedError = (input: {
  executionId: ExecutionRecord["id"];
  interactionId: string;
}): ExecutionSuspendedError =>
  new ExecutionSuspendedError({
    executionId: input.executionId,
    interactionId: input.interactionId,
    message: `${EXECUTION_SUSPENDED_SENTINEL}:${input.executionId}:${input.interactionId}`,
  });

const isExecutionSuspendedValue = (value: unknown): boolean => {
  if (value instanceof ExecutionSuspendedError) {
    return true;
  }

  if (value instanceof Error) {
    return value.message.includes(EXECUTION_SUSPENDED_SENTINEL);
  }

  return typeof value === "string" && value.includes(EXECUTION_SUSPENDED_SENTINEL);
};

const decodeStoredElicitationResponse = (input: {
  interactionId: string;
  responseJson: string | null;
}) =>
  Effect.try({
    try: () => {
      if (input.responseJson === null) {
        throw new Error(
          `Interaction ${input.interactionId} has no stored response`,
        );
      }

      return JSON.parse(input.responseJson);
    },
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  }).pipe(
    Effect.flatMap((decoded) =>
      decodeElicitationResponse(decoded).pipe(
        Effect.mapError((error) => new Error(String(error))),
      )
    ),
  );

const verifyStoredStepMatches = (input: {
  executionId: ExecutionRecord["id"];
  sequence: number;
  expectedPath: string;
  expectedArgsJson: string;
  actualPath: string;
  actualArgsJson: string;
}) => {
  if (
    input.expectedPath === input.actualPath
    && input.expectedArgsJson === input.actualArgsJson
  ) {
    return;
  }

  throw new Error(
    [
      `Durable execution mismatch for ${input.executionId} at tool step ${String(input.sequence)}.`,
      `Expected ${input.expectedPath}(${input.expectedArgsJson}) but replay reached ${input.actualPath}(${input.actualArgsJson}).`,
    ].join(" "),
  );
};

const fetchExecution = (
  store: ExecutionStoreShape,
  input: {
    workspaceId: WorkspaceId;
    executionId: ExecutionId;
    operation: OperationErrorsLike;
  },
) =>
  Effect.gen(function* () {
    const errors = asOperationErrors(input.operation);
    const existing = yield* errors.mapStorage(
      store.getById({
        workspaceId: input.workspaceId,
        executionId: input.executionId,
      }),
    );

    if (existing === null) {
      return yield* Effect.fail(errors.notFound(
          "Execution not found",
          `workspaceId=${input.workspaceId} executionId=${input.executionId}`,
        ));
    }

    return existing;
  });

type ExecutionEnvelopeResult = ExecutionEnvelope;

const findExecutionStepBySequence = (
  store: ExecutionStoreShape,
  input: {
    executionId: ExecutionId;
    sequence: number;
  },
) =>
  store.listSteps({ executionId: input.executionId }).pipe(
    Effect.map((steps) => steps.find((step) => step.sequence === input.sequence) ?? null),
  );

const updateExecutionStepBySequence = (
  store: ExecutionStoreShape,
  input: {
    executionId: ExecutionId;
    sequence: number;
    update: Parameters<ExecutionStoreShape["updateStep"]>[0]["update"];
  },
) =>
  Effect.gen(function* () {
    const step = yield* findExecutionStepBySequence(store, input);

    if (step === null) {
      return null;
    }

    return yield* store.updateStep({
      stepId: step.id,
      update: input.update,
    });
  });

const getStoredInteractionForStep = (
  store: ExecutionStoreShape,
  input: {
    executionId: ExecutionId;
    sequence: number | null;
  },
) =>
  Effect.gen(function* () {
    if (input.sequence === null) {
      return null;
    }

    const step = yield* findExecutionStepBySequence(store, {
      executionId: input.executionId,
      sequence: input.sequence,
    });

    if (step?.interactionId === null || step?.interactionId === undefined) {
      return null;
    }

    return yield* store.getInteractionById({
      interactionId: step.interactionId,
    });
  });

const fetchExecutionEnvelope = (
  store: ExecutionStoreShape,
  input: {
    workspaceId: WorkspaceId;
    executionId: ExecutionId;
    operation: OperationErrorsLike;
  },
): Effect.Effect<ExecutionEnvelopeResult, Error> =>
  Effect.gen(function* () {
    const errors = asOperationErrors(input.operation);
    const execution = yield* fetchExecution(store, input);
    const pendingInteraction = yield* errors.child("pending_interaction").mapStorage(
      store.getPendingInteraction({ executionId: input.executionId }),
    );

    return {
      execution,
      pendingInteraction,
    };
  });

const waitForExecutionEnvelopeToSettle = (
  store: ExecutionStoreShape,
  input: {
    workspaceId: WorkspaceId;
    executionId: ExecutionId;
    operation: OperationErrorsLike;
    previousPendingInteractionId: string | null;
    attemptsRemaining: number;
  },
): Effect.Effect<ExecutionEnvelopeResult, Error, never> =>
  Effect.gen(function* () {
    const envelope = yield* fetchExecutionEnvelope(store, input);
    if (
      (
        envelope.execution.status !== "running"
        && !(
          envelope.execution.status === "waiting_for_interaction"
          && (
            envelope.pendingInteraction === null
            || envelope.pendingInteraction.id === input.previousPendingInteractionId
          )
        )
      )
      || input.attemptsRemaining <= 0
    ) {
      return envelope;
    }

    yield* Effect.promise(
      () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
    );
    return yield* waitForExecutionEnvelopeToSettle(store, {
      ...input,
      attemptsRemaining: input.attemptsRemaining - 1,
    });
  });

const suspendExecutionForInteraction = (input: {
  rows: ExecutionStoreShape;
  executionId: ExecutionId;
  liveExecutionManager: LiveExecutionManager;
  request: Parameters<OnElicitation>[0];
  existingInteractionId?: string | null;
}) =>
  Effect.gen(function* () {
    const stepSequence = executionStepSequenceFromContext(input.request.context);
    const existing =
      input.existingInteractionId === undefined || input.existingInteractionId === null
        ? null
        : yield* input.rows.getInteractionById({
            interactionId: input.existingInteractionId,
          });

    if (existing !== null && existing.status !== "pending") {
      return yield* decodeStoredElicitationResponse({
        interactionId: existing.id,
        responseJson: existing.responsePrivateJson ?? existing.responseJson,
      });
    }

    const interaction =
      existing
      ?? (yield* input.rows.createInteraction({
        executionId: input.executionId,
        kind: input.request.elicitation.mode === "url" ? "url" : "form",
        purpose: "elicitation",
        payloadJson:
          serializeJson({
            path: input.request.path,
            sourceKey: input.request.sourceKey,
            args: input.request.args,
            context: input.request.context,
            elicitation: input.request.elicitation,
          }) ?? "{}",
      }));

    if (stepSequence !== null) {
      yield* updateExecutionStepBySequence(input.rows, {
        executionId: input.executionId,
        sequence: stepSequence,
        update: {
          status: "waiting",
          interactionId: interaction.id,
        },
      });
    }

    yield* input.rows.update({
      executionId: input.executionId,
      update: {
        status: "waiting_for_interaction",
      },
    });
    yield* input.liveExecutionManager.publishState({
      executionId: input.executionId,
      state: "waiting_for_interaction",
    });

    return yield* createExecutionSuspendedError({
        executionId: input.executionId,
        interactionId: interaction.id,
      });
  });

const createHybridOnElicitation = (input: {
  rows: ExecutionStoreShape;
  executionId: ExecutionId;
  liveExecutionManager: LiveExecutionManager;
  interactionMode: InteractionMode;
}): OnElicitation => {
  const liveOnElicitation = input.liveExecutionManager.createOnElicitation({
    rows: input.rows,
    executionId: input.executionId,
  });

  return (request) =>
    Effect.gen(function* () {
      const stepSequence = executionStepSequenceFromContext(request.context);
      const existing = yield* getStoredInteractionForStep(input.rows, {
        executionId: input.executionId,
        sequence: stepSequence,
      });

      if (existing !== null && existing.status !== "pending") {
        return yield* decodeStoredElicitationResponse({
          interactionId: existing.id,
          responseJson: existing.responsePrivateJson ?? existing.responseJson,
        });
      }

      const allowLiveWait =
        input.interactionMode === "live"
        || (input.interactionMode === "live_form" && request.elicitation.mode !== "url");

      if (existing === null && allowLiveWait) {
        return yield* liveOnElicitation(request);
      }

      return yield* suspendExecutionForInteraction({
        rows: input.rows,
        executionId: input.executionId,
        liveExecutionManager: input.liveExecutionManager,
        request,
        existingInteractionId: existing?.id ?? null,
      });
    });
};

const createReplayToolInvoker = (input: {
  rows: ExecutionStoreShape;
  executionId: ExecutionId;
  toolInvoker: ToolInvoker;
}): ToolInvoker => ({
  invoke: ({ path, args, context }) =>
    Effect.gen(function* () {
      const stepSequence = executionStepSequenceFromContext(context);
      if (stepSequence === null) {
        return yield* input.toolInvoker.invoke({ path, args, context });
      }

      const argsJson = serializeRequiredJson(args);
      const existing = yield* findExecutionStepBySequence(input.rows, {
        executionId: input.executionId,
        sequence: stepSequence,
      });

      if (existing !== null) {
        verifyStoredStepMatches({
          executionId: input.executionId,
          sequence: stepSequence,
          expectedPath: existing.path,
          expectedArgsJson: existing.argsJson,
          actualPath: path,
          actualArgsJson: argsJson,
        });

        if (existing.status === "completed") {
          return parseStoredJson(existing.resultJson);
        }

        if (existing.status === "failed") {
          return yield* runtimeEffectError("execution/service",
              existing.errorText
                ?? `Stored tool step ${String(stepSequence)} failed`,
            );
        }
      } else {
        yield* input.rows.createStep({
          executionId: input.executionId,
          sequence: stepSequence,
          kind: "tool_call",
          path,
          argsJson,
        });
      }

      try {
        const value = yield* input.toolInvoker.invoke({ path, args, context });

        yield* updateExecutionStepBySequence(input.rows, {
          executionId: input.executionId,
          sequence: stepSequence,
          update: {
            status: "completed",
            resultJson: serializeJson(value),
            errorText: null,
          },
        });

        return value;
      } catch (error) {
        if (isExecutionSuspendedValue(error)) {
          yield* updateExecutionStepBySequence(input.rows, {
            executionId: input.executionId,
            sequence: stepSequence,
            update: {
              status: "waiting",
            },
          });

          return yield* Effect.fail(error);
        }

        yield* updateExecutionStepBySequence(input.rows, {
          executionId: input.executionId,
          sequence: stepSequence,
          update: {
            status: "failed",
            errorText: error instanceof Error ? error.message : String(error),
          },
        });

        return yield* Effect.fail(error);
      }
    }),
});

const persistExecutionOutcome = (input: {
  rows: ExecutionStoreShape;
  liveExecutionManager: LiveExecutionManager;
  workspaceId: WorkspaceId;
  executionId: ExecutionId;
  outcome: {
    result: unknown;
    error?: string;
    logs?: string[];
  };
}) =>
  Effect.gen(function* () {
    if (isExecutionSuspendedValue(input.outcome.error)) {
      return;
    }

    const [execution, pendingInteraction] = yield* Effect.all([
      input.rows.getById({
        workspaceId: input.workspaceId,
        executionId: input.executionId,
      }),
      input.rows.getPendingInteraction({ executionId: input.executionId }),
    ]);

    if (
      execution !== null
      && execution.status === "waiting_for_interaction"
      && pendingInteraction !== null
    ) {
      return;
    }

    const updated = yield* input.rows.update({
      executionId: input.executionId,
      update: {
        status: input.outcome.error ? "failed" : "completed",
        resultJson: serializeJson(input.outcome.result),
        errorText: input.outcome.error ?? null,
        logsJson: serializeJson(input.outcome.logs ?? null),
        completedAt: Date.now(),
      },
    });

    yield* input.liveExecutionManager.finishRun({
      executionId: input.executionId,
      state: updated.status === "completed" ? "completed" : "failed",
    });
  });

const persistExecutionFailure = (input: {
  rows: ExecutionStoreShape;
  liveExecutionManager: LiveExecutionManager;
  executionId: ExecutionId;
  error: string;
}) =>
  Effect.gen(function* () {
    yield* input.rows.update({
      executionId: input.executionId,
      update: {
        status: "failed",
        errorText: input.error,
        completedAt: Date.now(),
      },
    });

    yield* input.liveExecutionManager.finishRun({
      executionId: input.executionId,
      state: "failed",
    });
  });

const runExecutionAttemptWithDependencies = (
  store: ExecutionStoreShape,
  executionResolver: ResolveExecutionEnvironment,
  liveExecutionManager: LiveExecutionManager,
  execution: { id: ExecutionId; workspaceId: WorkspaceId; createdByAccountId: AccountId; executionSessionId: ExecutionSessionId | null; code: string },
  interactionMode: InteractionMode,
) =>
  executionResolver({
    workspaceId: execution.workspaceId,
    accountId: execution.createdByAccountId,
    executionId: execution.id,
    onElicitation: createHybridOnElicitation({
      rows: store,
      executionId: execution.id,
      liveExecutionManager,
      interactionMode,
    }),
  }).pipe(
    Effect.map((environment) => ({
      executor: environment.executor,
      toolInvoker: withExecutionInvocationContext({
        executionId: execution.id,
        executionSessionId: execution.executionSessionId,
        actorAccountId: execution.createdByAccountId,
        toolInvoker: createReplayToolInvoker({
          rows: store,
          executionId: execution.id,
          toolInvoker: environment.toolInvoker,
        }),
      }),
    })),
    Effect.flatMap(({ executor, toolInvoker }) =>
      executor.execute(execution.code, toolInvoker)
    ),
    Effect.flatMap((outcome) =>
      persistExecutionOutcome({
        rows: store,
        liveExecutionManager,
        workspaceId: execution.workspaceId,
        executionId: execution.id,
        outcome,
      })
    ),
    Effect.catchAll((error) =>
      persistExecutionFailure({
        rows: store,
        liveExecutionManager,
        executionId: execution.id,
        error: error instanceof Error ? error.message : String(error),
      }).pipe(
        Effect.catchAll(() => liveExecutionManager.clearRun(execution.id)),
      )
    ),
  );

const forkExecutionAttemptWithDependencies = (
  store: ExecutionStoreShape,
  executionResolver: ResolveExecutionEnvironment,
  liveExecutionManager: LiveExecutionManager,
  execution: { id: ExecutionId; workspaceId: WorkspaceId; createdByAccountId: AccountId; executionSessionId: ExecutionSessionId | null; code: string },
  interactionMode: InteractionMode,
) =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* getRuntimeLocalWorkspaceOption();

    yield* Effect.sync(() => {
      const effect = runExecutionAttemptWithDependencies(
        store,
        executionResolver,
        liveExecutionManager,
        execution,
        interactionMode,
      );

      Effect.runFork(
        provideOptionalRuntimeLocalWorkspace(effect, runtimeLocalWorkspace),
      );
    });
  });

const submitExecutionInteractionResponseWithDependencies = (
  store: ExecutionStoreShape,
  executionResolver: ResolveExecutionEnvironment,
  liveExecutionManager: LiveExecutionManager,
  input: {
    workspaceId: WorkspaceId;
    executionId: ExecutionId;
    response: ElicitationResponse;
    interactionMode: InteractionMode;
  },
) =>
  Effect.gen(function* () {
    const execution = yield* store.getById({
      workspaceId: input.workspaceId,
      executionId: input.executionId,
    });

    if (execution === null) {
      return false;
    }

    const pendingInteraction = yield* store.getPendingInteraction({
      executionId: input.executionId,
    });

    if (pendingInteraction === null) {
      return false;
    }

    if (
      execution.status !== "waiting_for_interaction"
      && execution.status !== "failed"
    ) {
      return false;
    }

    const steps = yield* store.listSteps({ executionId: input.executionId });
    const waitingStep = [...steps]
      .reverse()
      .find((step) => step.interactionId === pendingInteraction.id);

    if (waitingStep) {
      yield* updateExecutionStepBySequence(store, {
        executionId: input.executionId,
        sequence: waitingStep.sequence,
        update: {
          status: "pending",
          errorText: null,
          interactionId: null,
        },
      });
    }

    yield* store.resolveInteraction({
      interactionId: pendingInteraction.id,
      responseJson: serializeJson(
        sanitizePersistedElicitationResponse(input.response),
      ),
      responsePrivateJson: serializeJson(input.response),
    });

    const updated = yield* store.update({
      executionId: input.executionId,
      update: {
        status: "running",
      },
    });

    yield* forkExecutionAttemptWithDependencies(
      store,
      executionResolver,
      liveExecutionManager,
      updated,
      input.interactionMode,
    );

    return true;
  });

const createExecutionWithDependencies = (
  store: ExecutionStoreShape,
  executionResolver: ResolveExecutionEnvironment,
  liveExecutionManager: LiveExecutionManager,
  input: {
    workspaceId: WorkspaceId;
    payload: CreateExecutionPayload;
    createdByAccountId: AccountId;
  },
) =>
  Effect.gen(function* () {
    const created = yield* executionOps.create.child("insert").mapStorage(
      store.create({
        workspaceId: input.workspaceId,
        accountId: input.createdByAccountId,
        code: input.payload.code,
        executionSessionId: input.payload.executionSessionId ?? null,
      }),
    );

    const running = yield* executionOps.create.child("mark_running").mapStorage(
      store.update({
        executionId: created.id,
        update: {
          status: "running",
          startedAt: Date.now(),
        },
      }),
    );

    const nextState = yield* liveExecutionManager.registerStateWaiter(created.id);

    yield* forkExecutionAttemptWithDependencies(
      store,
      executionResolver,
      liveExecutionManager,
      running,
      resolveInteractionMode(input.payload.interactionMode),
    );

    yield* Deferred.await(nextState);

    return yield* fetchExecutionEnvelope(store, {
      workspaceId: input.workspaceId,
      executionId: created.id,
      operation: executionOps.create,
    });
  });

export const createExecution = (input: {
  workspaceId: WorkspaceId;
  payload: CreateExecutionPayload;
  createdByAccountId: AccountId;
}) =>
  Effect.gen(function* () {
    const store = yield* ExecutionStore;
    const executionResolver = yield* ExecutionEnvironmentResolver;
    const liveExecutionManager = yield* ExecutionManager;

    return yield* createExecutionWithDependencies(
      store,
      executionResolver,
      liveExecutionManager,
      input,
    );
  });

export const getExecution = (input: {
  workspaceId: WorkspaceId;
  executionId: ExecutionId;
}) =>
  Effect.flatMap(ExecutionStore, (store) =>
    fetchExecutionEnvelope(store, {
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      operation: executionOps.get,
    })
  );

export const submitExecutionInteractionResponse = (input: {
  workspaceId: WorkspaceId;
  executionId: ExecutionId;
  response: ElicitationResponse;
  interactionMode?: InteractionMode;
}) =>
  Effect.gen(function* () {
    const store = yield* ExecutionStore;
    const executionResolver = yield* ExecutionEnvironmentResolver;
    const liveExecutionManager = yield* ExecutionManager;

    return yield* submitExecutionInteractionResponseWithDependencies(
      store,
      executionResolver,
        liveExecutionManager,
        {
          ...input,
          interactionMode: input.interactionMode ?? DEFAULT_INTERACTION_MODE,
        },
      );
  });

export const resumeExecution = (input: {
  workspaceId: WorkspaceId;
  executionId: ExecutionId;
  payload: ResumeExecutionPayload;
  resumedByAccountId: AccountId;
}) =>
  Effect.gen(function* () {
    const executionStore = yield* ExecutionStore;
    const executionResolver = yield* ExecutionEnvironmentResolver;
    const liveExecutionManager = yield* ExecutionManager;

    const existing = yield* fetchExecutionEnvelope(executionStore, {
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      operation: "executions.resume",
    });

    if (
      existing.execution.status !== "waiting_for_interaction"
      && !(
        existing.execution.status === "failed"
        && existing.pendingInteraction !== null
      )
    ) {
      return yield* Effect.fail(executionOps.resume.badRequest(
          "Execution is not waiting for interaction",
          `executionId=${input.executionId} status=${existing.execution.status}`,
        ));
    }

    const responseJson = input.payload.responseJson;
    const response =
      responseJson === undefined
        ? { action: "accept" as const }
        : yield* Effect.try({
            try: () => JSON.parse(responseJson),
            catch: (error) =>
              executionOps.resume.badRequest(
                "Invalid responseJson",
                error instanceof Error ? error.message : String(error),
              ),
          }).pipe(
            Effect.flatMap((decoded) =>
              decodeElicitationResponse(decoded).pipe(
                Effect.mapError((error) =>
                  executionOps.resume.badRequest(
                    "Invalid responseJson",
                    String(error),
                  ),
                ),
              )
            ),
          );

    const resumedLive = yield* liveExecutionManager.resolveInteraction({
      executionId: input.executionId,
      response,
    });

    if (!resumedLive) {
      const resumed = yield* executionOps.resume.child("submit_interaction").mapStorage(
        submitExecutionInteractionResponseWithDependencies(
          executionStore,
          executionResolver,
          liveExecutionManager,
          {
            workspaceId: input.workspaceId,
            executionId: input.executionId,
            response,
            interactionMode: resolveInteractionMode(input.payload.interactionMode),
          },
        ),
      );

      if (!resumed) {
        return yield* Effect.fail(executionOps.resume.badRequest(
            "Resume is unavailable for this execution",
            `executionId=${input.executionId}`,
          ));
      }
    }

    return yield* waitForExecutionEnvelopeToSettle(executionStore, {
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      operation: executionOps.resume,
      previousPendingInteractionId: existing.pendingInteraction?.id ?? null,
      attemptsRemaining: 400,
    });
  });

export const listExecutions = (input: {
  workspaceId: WorkspaceId;
}) =>
  Effect.flatMap(ExecutionStore, (store) =>
    executionOps.list.mapStorage(
      store.list({ workspaceId: input.workspaceId }),
    ),
  );

export const listExecutionSteps = (input: {
  workspaceId: WorkspaceId;
  executionId: ExecutionId;
}) =>
  Effect.gen(function* () {
    const store = yield* ExecutionStore;

    yield* fetchExecution(store, {
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      operation: executionOps.listSteps,
    });

    return yield* executionOps.listSteps.mapStorage(
      store.listSteps({ executionId: input.executionId }),
    );
  });

export const closeExecutionSession = (input: {
  workspaceId: WorkspaceId;
  executionSessionId: ExecutionSessionId;
  accountId: AccountId;
}) =>
  clearMcpConnectionPoolSession({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    executionSessionId: input.executionSessionId,
  }).pipe(
    Effect.as({
      closed: true,
    }),
  );
