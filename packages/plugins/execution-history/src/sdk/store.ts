import { Effect, Option, Predicate, Schema } from "effect";

import {
  type ExecutionEvent,
  type ExecutionInteractionId,
  type ExecutionObserver,
  type ExecutionToolCallId,
  type Owner,
  type OwnerBinding,
  type PluginStorageCollectionFacade,
  type PluginStorageFacade,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import {
  type InteractionRow,
  type InteractionStatus,
  type RunRow,
  type RunStatus,
  type ToolCallRow,
  type ToolCallStatus,
  interactions,
  runs,
  toolCalls,
} from "./collections";

// ---------------------------------------------------------------------------
// Execution-history store. Translates the engine's ExecutionEvent stream into
// durable run/tool-call/interaction rows and exposes the read surface.
//
// Write model — buffered batch: tool-call and interaction detail is held in an
// in-memory buffer keyed by executionId and only flushed when the execution
// finishes, so a completed run lands as one batch of writes rather than a
// write-per-event. Two points are written eagerly for durability even before
// the buffer flushes: the `runs` row on ExecutionStarted (status "running") and
// again on InteractionStarted (status "waiting_for_interaction"), so a paused
// run survives a restart while it waits on the user.
//
// Every `unknown` payload (tool args/results, interaction payload/response,
// execution result/logs) is serialized to a JSON string via Effect Schema
// (`Schema.UnknownFromJsonString`) — no raw `JSON.stringify` in domain code.
// ---------------------------------------------------------------------------

/** Serialize an arbitrary value to a JSON string, or null when absent or when
 *  the value isn't JSON-encodable (encoding never throws). */
const encodeUnknownJson = Schema.encodeUnknownOption(Schema.UnknownFromJsonString);

const toJson = (value: unknown): string | null =>
  value === undefined ? null : Option.getOrNull(encodeUnknownJson(value));

const ownerOf = (binding: OwnerBinding): Owner => (binding.subject != null ? "user" : "org");

/** First dot-delimited segment of a tool path (its namespace), or null. */
const namespaceOf = (path: string): string | null => {
  const index = path.indexOf(".");
  return index > 0 ? path.slice(0, index) : null;
};

interface BufferedToolCall {
  toolCallId: ExecutionToolCallId;
  status: ToolCallStatus;
  path: string;
  namespace: string | null;
  argsJson: string | null;
  resultJson: string | null;
  errorText: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
}

interface BufferedInteraction {
  interactionId: ExecutionInteractionId;
  status: InteractionStatus;
  kind: string;
  purpose: string | null;
  payloadJson: string | null;
  responseJson: string | null;
  errorText: string | null;
  startedAt: number;
  completedAt: number | null;
}

interface RunBuffer {
  owner: Owner;
  startedAt: number;
  // Retained from ExecutionStarted so every re-write of the run row (waiting,
  // terminal) keeps the code + trigger — later events don't carry them.
  code: string;
  triggerKind: string | null;
  triggerMetaJson: string | null;
  hadInteraction: boolean;
  toolCalls: Map<string, BufferedToolCall>;
  interactions: Map<string, BufferedInteraction>;
}

// ---------------------------------------------------------------------------
// Read-surface option/result types.
// ---------------------------------------------------------------------------

export interface ExecutionHistoryListOptions {
  readonly statusFilter?: readonly RunStatus[];
  readonly triggerFilter?: readonly string[];
  readonly timeRange?: { readonly from?: number; readonly to?: number };
  readonly hadInteraction?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  readonly sort?: "asc" | "desc";
}

export interface ExecutionHistoryListResult {
  readonly runs: readonly RunRow[];
  readonly total: number;
}

export interface ExecutionHistoryDetail {
  readonly run: RunRow;
  readonly toolCalls: readonly ToolCallRow[];
  readonly interactions: readonly InteractionRow[];
}

export interface ExecutionHistoryStore {
  readonly handleEvent: (event: ExecutionEvent) => Effect.Effect<void, StorageFailure>;
  readonly list: (
    options?: ExecutionHistoryListOptions,
  ) => Effect.Effect<ExecutionHistoryListResult, StorageFailure>;
  readonly get: (
    executionId: string,
  ) => Effect.Effect<ExecutionHistoryDetail | null, StorageFailure>;
  readonly listToolCalls: (
    executionId: string,
  ) => Effect.Effect<readonly ToolCallRow[], StorageFailure>;
}

export const makeExecutionHistoryStore = (deps: StorageDeps): ExecutionHistoryStore => {
  const pluginStorage: PluginStorageFacade = deps.pluginStorage;
  const runsC: PluginStorageCollectionFacade<typeof runs> = pluginStorage.collection(runs);
  const toolCallsC: PluginStorageCollectionFacade<typeof toolCalls> =
    pluginStorage.collection(toolCalls);
  const interactionsC: PluginStorageCollectionFacade<typeof interactions> =
    pluginStorage.collection(interactions);

  const buffers = new Map<string, RunBuffer>();

  const putRun = (owner: Owner, row: RunRow): Effect.Effect<void, StorageFailure> =>
    runsC.put({ owner, key: row.executionId, data: row }).pipe(Effect.asVoid);

  const onExecutionStarted = (event: Extract<ExecutionEvent, { _tag: "ExecutionStarted" }>) => {
    const owner = ownerOf(event.owner);
    const startedAt = event.startedAt.getTime();
    const triggerKind = event.trigger?.kind ?? null;
    const triggerMetaJson = toJson(event.trigger?.metadata);
    buffers.set(event.executionId, {
      owner,
      startedAt,
      code: event.code,
      triggerKind,
      triggerMetaJson,
      hadInteraction: false,
      toolCalls: new Map(),
      interactions: new Map(),
    });
    return putRun(owner, {
      executionId: event.executionId,
      status: "running",
      code: event.code,
      resultJson: null,
      errorText: null,
      logsJson: null,
      triggerKind,
      triggerMetaJson,
      startedAt,
      completedAt: null,
      durationMs: null,
      toolCallCount: 0,
      hadInteraction: false,
    });
  };

  const onToolCallStarted = (event: Extract<ExecutionEvent, { _tag: "ToolCallStarted" }>) => {
    const buffer = buffers.get(event.executionId);
    if (buffer) {
      buffer.toolCalls.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        status: "running",
        path: event.path,
        namespace: namespaceOf(event.path),
        argsJson: toJson(event.args),
        resultJson: null,
        errorText: null,
        startedAt: event.startedAt.getTime(),
        completedAt: null,
        durationMs: null,
      });
    }
    return Effect.void;
  };

  const onToolCallFinished = (event: Extract<ExecutionEvent, { _tag: "ToolCallFinished" }>) => {
    const buffer = buffers.get(event.executionId);
    if (buffer) {
      const completedAt = event.completedAt.getTime();
      const existing = buffer.toolCalls.get(event.toolCallId);
      const startedAt = existing?.startedAt ?? completedAt;
      buffer.toolCalls.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        status: event.status,
        path: event.path,
        namespace: existing?.namespace ?? namespaceOf(event.path),
        argsJson: existing?.argsJson ?? null,
        resultJson: toJson(event.result),
        errorText: event.error ?? null,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
      });
    }
    return Effect.void;
  };

  const onInteractionStarted = (event: Extract<ExecutionEvent, { _tag: "InteractionStarted" }>) => {
    const buffer = buffers.get(event.executionId);
    if (!buffer) return Effect.void;
    const request = event.context.request;
    const kind = Predicate.isTagged(request, "UrlElicitation")
      ? "UrlElicitation"
      : "FormElicitation";
    buffer.interactions.set(event.interactionId, {
      interactionId: event.interactionId,
      status: "pending",
      kind,
      purpose: request.message,
      payloadJson: toJson(event.context),
      responseJson: null,
      errorText: null,
      startedAt: event.startedAt.getTime(),
      completedAt: null,
    });
    buffer.hadInteraction = true;
    return putRun(buffer.owner, {
      executionId: event.executionId,
      status: "waiting_for_interaction",
      code: buffer.code,
      resultJson: null,
      errorText: null,
      logsJson: null,
      triggerKind: buffer.triggerKind,
      triggerMetaJson: buffer.triggerMetaJson,
      startedAt: buffer.startedAt,
      completedAt: null,
      durationMs: null,
      toolCallCount: buffer.toolCalls.size,
      hadInteraction: true,
    });
  };

  const onInteractionResolved = (
    event: Extract<ExecutionEvent, { _tag: "InteractionResolved" }>,
  ) => {
    const buffer = buffers.get(event.executionId);
    if (buffer) {
      const existing = buffer.interactions.get(event.interactionId);
      buffer.interactions.set(event.interactionId, {
        interactionId: event.interactionId,
        status: event.status,
        kind: existing?.kind ?? "unknown",
        purpose: existing?.purpose ?? null,
        payloadJson: existing?.payloadJson ?? null,
        responseJson: toJson(event.response),
        errorText: event.error ?? null,
        startedAt: existing?.startedAt ?? event.completedAt.getTime(),
        completedAt: event.completedAt.getTime(),
      });
    }
    return Effect.void;
  };

  const onExecutionFinished = (event: Extract<ExecutionEvent, { _tag: "ExecutionFinished" }>) => {
    const buffer = buffers.get(event.executionId);
    const owner = buffer?.owner ?? ownerOf(event.owner);
    const completedAt = event.completedAt.getTime();
    const toolCallEntries = buffer ? Array.from(buffer.toolCalls.values()) : [];
    const interactionEntries = buffer ? Array.from(buffer.interactions.values()) : [];

    return Effect.gen(function* () {
      // Preserve code/trigger/startedAt from the buffer, or from the persisted
      // "running" row if the buffer was lost (e.g. a restart mid-run).
      const existing = buffer ? null : yield* runsC.get({ key: event.executionId });
      const code = buffer?.code ?? existing?.data.code ?? "";
      const triggerKind = buffer?.triggerKind ?? existing?.data.triggerKind ?? null;
      const triggerMetaJson = buffer?.triggerMetaJson ?? existing?.data.triggerMetaJson ?? null;
      const startedAt = buffer?.startedAt ?? existing?.data.startedAt ?? completedAt;
      const hadInteraction =
        buffer?.hadInteraction ?? (existing?.data.hadInteraction || interactionEntries.length > 0);

      yield* putRun(owner, {
        executionId: event.executionId,
        status: event.status,
        code,
        resultJson: toJson(event.result),
        errorText: event.error ?? null,
        logsJson: toJson(event.logs),
        triggerKind,
        triggerMetaJson,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        toolCallCount: toolCallEntries.length,
        hadInteraction,
      });

      yield* Effect.forEach(
        toolCallEntries,
        (entry) =>
          toolCallsC.put({
            owner,
            key: entry.toolCallId,
            data: {
              executionId: event.executionId,
              toolCallId: entry.toolCallId,
              status: entry.status,
              path: entry.path,
              namespace: entry.namespace,
              argsJson: entry.argsJson,
              resultJson: entry.resultJson,
              errorText: entry.errorText,
              startedAt: entry.startedAt,
              completedAt: entry.completedAt,
              durationMs: entry.durationMs,
            },
          }),
        { discard: true },
      );

      yield* Effect.forEach(
        interactionEntries,
        (entry) =>
          interactionsC.put({
            owner,
            key: entry.interactionId,
            data: {
              executionId: event.executionId,
              interactionId: entry.interactionId,
              status: entry.status,
              kind: entry.kind,
              purpose: entry.purpose,
              payloadJson: entry.payloadJson,
              responseJson: entry.responseJson,
              errorText: entry.errorText,
              startedAt: entry.startedAt,
              completedAt: entry.completedAt,
            },
          }),
        { discard: true },
      );

      buffers.delete(event.executionId);
    });
  };

  const handleEvent = (event: ExecutionEvent): Effect.Effect<void, StorageFailure> => {
    if (Predicate.isTagged(event, "ExecutionStarted")) return onExecutionStarted(event);
    if (Predicate.isTagged(event, "ToolCallStarted")) return onToolCallStarted(event);
    if (Predicate.isTagged(event, "ToolCallFinished")) return onToolCallFinished(event);
    if (Predicate.isTagged(event, "InteractionStarted")) return onInteractionStarted(event);
    if (Predicate.isTagged(event, "InteractionResolved")) return onInteractionResolved(event);
    return onExecutionFinished(event);
  };

  const list = (
    options?: ExecutionHistoryListOptions,
  ): Effect.Effect<ExecutionHistoryListResult, StorageFailure> => {
    const where: {
      status?: { in: readonly RunStatus[] };
      triggerKind?: { in: readonly string[] };
      startedAt?: { gte?: number; lte?: number };
      hadInteraction?: { eq: boolean };
    } = {};
    if (options?.statusFilter && options.statusFilter.length > 0) {
      where.status = { in: options.statusFilter };
    }
    if (options?.triggerFilter && options.triggerFilter.length > 0) {
      where.triggerKind = { in: options.triggerFilter };
    }
    if (options?.timeRange) {
      where.startedAt = {};
      if (options.timeRange.from != null) where.startedAt.gte = options.timeRange.from;
      if (options.timeRange.to != null) where.startedAt.lte = options.timeRange.to;
    }
    if (options?.hadInteraction != null) {
      where.hadInteraction = { eq: options.hadInteraction };
    }

    return Effect.gen(function* () {
      const rows = yield* runsC.query({
        where,
        orderBy: [{ field: "startedAt", direction: options?.sort ?? "desc" }],
        limit: options?.limit,
        offset: options?.offset,
      });
      const total = yield* runsC.count({ where });
      return { runs: rows.map((entry) => entry.data), total };
    });
  };

  const get = (executionId: string): Effect.Effect<ExecutionHistoryDetail | null, StorageFailure> =>
    Effect.gen(function* () {
      const run = yield* runsC.get({ key: executionId });
      if (run === null) return null;
      const toolCallRows = yield* toolCallsC.query({
        where: { executionId },
        orderBy: [{ field: "startedAt" }],
      });
      const interactionRows = yield* interactionsC.query({
        where: { executionId },
        orderBy: [{ field: "startedAt" }],
      });
      return {
        run: run.data,
        toolCalls: toolCallRows.map((entry) => entry.data),
        interactions: interactionRows.map((entry) => entry.data),
      };
    });

  const listToolCalls = (
    executionId: string,
  ): Effect.Effect<readonly ToolCallRow[], StorageFailure> =>
    toolCallsC
      .query({ where: { executionId }, orderBy: [{ field: "startedAt" }] })
      .pipe(Effect.map((rows) => rows.map((entry) => entry.data)));

  return { handleEvent, list, get, listToolCalls };
};

/** Build an ExecutionObserver over a store instance — every engine event is
 *  forwarded to the store's buffered-batch writer. */
export const makeExecutionHistoryObserver = (
  store: Pick<ExecutionHistoryStore, "handleEvent">,
): ExecutionObserver<StorageFailure> => ({
  handle: (event) => store.handleEvent(event),
});
