import { Effect, Option, Predicate, Schedule, Schema } from "effect";

import {
  type ExecutionEvent,
  ExecutionInteractionId,
  type ExecutionObserver,
  ExecutionToolCallId,
  type Owner,
  type OwnerBinding,
  type PluginStorageCollectionFacade,
  type PluginStorageFacade,
  StorageError,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import {
  InteractionRow,
  type InteractionStatus,
  RunRow,
  type RunStatus,
  ToolCallRow,
  type ToolCallStatus,
  interactions,
  runs,
  terminalOutboxes,
  toolCalls,
} from "./collections";

// ---------------------------------------------------------------------------
// Execution-history store. Translates the engine's ExecutionEvent stream into
// durable run/tool-call/interaction rows and exposes the read surface.
//
// Write model — buffered batch: tool-call and interaction detail is held in an
// in-memory buffer keyed by executionId and only flushed when the execution
// finishes, so a completed run lands as one batch of writes rather than a
// write-per-event. Before that terminal batch, its complete payload is written
// to the blob seam as a durable outbox; reads replay an unfinished publication
// after a restart. Two points are written eagerly even before the flush: the
// `runs` row on ExecutionStarted (status "running") and again on
// InteractionStarted (status "waiting_for_interaction"), so its history stays
// inspectable if the observer/store restarts while the engine waits on a user.
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

const PendingTerminalPublication = Schema.Struct({
  owner: Schema.Literals(["org", "user"]),
  run: RunRow,
  toolCalls: Schema.Array(ToolCallRow),
  interactions: Schema.Array(InteractionRow),
});
type PendingTerminalPublication = typeof PendingTerminalPublication.Type;

const PendingTerminalPublicationFromJsonString = Schema.fromJsonString(PendingTerminalPublication);
const encodePendingTerminalPublication = Schema.encodeUnknownEffect(
  PendingTerminalPublicationFromJsonString,
);
const decodePendingTerminalPublication = Schema.decodeUnknownEffect(
  PendingTerminalPublicationFromJsonString,
);

const pendingTerminalBlobKey = (executionId: string): string => `pending-terminal/${executionId}`;

const isNonterminalRun = (row: RunRow): boolean =>
  row.status === "running" || row.status === "waiting_for_interaction";

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

/** Filters and offset pagination for persisted execution summaries. */
export interface ExecutionHistoryListOptions {
  readonly statusFilter?: readonly RunStatus[];
  readonly triggerFilter?: readonly string[];
  readonly timeRange?: { readonly from?: number; readonly to?: number };
  readonly hadInteraction?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  readonly sort?: "asc" | "desc";
}

/** A page of execution summaries and the matching row count. */
export interface ExecutionHistoryListResult {
  readonly runs: readonly RunRow[];
  readonly total: number;
}

/** One execution and its persisted tool-call and interaction records. */
export interface ExecutionHistoryDetail {
  readonly run: RunRow;
  readonly toolCalls: readonly ToolCallRow[];
  readonly interactions: readonly InteractionRow[];
}

/** Persistence and query capability consumed by the history plugin. */
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

/** Create an execution-history store over Executor's owner-scoped plugin storage. */
export const makeExecutionHistoryStore = (deps: StorageDeps): ExecutionHistoryStore => {
  const pluginStorage: PluginStorageFacade = deps.pluginStorage;
  const runsC: PluginStorageCollectionFacade<typeof runs> = pluginStorage.collection(runs);
  const toolCallsC: PluginStorageCollectionFacade<typeof toolCalls> =
    pluginStorage.collection(toolCalls);
  const interactionsC: PluginStorageCollectionFacade<typeof interactions> =
    pluginStorage.collection(interactions);
  const terminalOutboxesC: PluginStorageCollectionFacade<typeof terminalOutboxes> =
    pluginStorage.collection(terminalOutboxes);
  const blobs = deps.blobs;

  const buffers = new Map<string, RunBuffer>();

  const putRun = (owner: Owner, row: RunRow): Effect.Effect<void, StorageFailure> =>
    runsC.put({ owner, key: row.executionId, data: row }).pipe(Effect.asVoid);

  const publicationEntries = (publication: PendingTerminalPublication) => [
    ...publication.toolCalls.map((entry) => ({
      collection: toolCalls.name,
      key: entry.toolCallId,
      data: entry,
    })),
    ...publication.interactions.map((entry) => ({
      collection: interactions.name,
      key: entry.interactionId,
      data: entry,
    })),
    {
      collection: runs.name,
      key: publication.run.executionId,
      data: publication.run,
    },
    {
      collection: terminalOutboxes.name,
      key: publication.run.executionId,
      data: { executionId: publication.run.executionId },
    },
  ];

  const publishTerminal = (
    publication: PendingTerminalPublication,
  ): Effect.Effect<void, StorageFailure> =>
    pluginStorage.putMany({
      owner: publication.owner,
      entries: publicationEntries(publication),
    });

  const writePendingTerminal = (
    publication: PendingTerminalPublication,
  ): Effect.Effect<void, StorageFailure> =>
    encodePendingTerminalPublication(publication).pipe(
      Effect.mapError(
        (cause) =>
          new StorageError({
            message: "execution-history: failed to encode pending terminal publication",
            cause,
          }),
      ),
      Effect.flatMap((encoded) =>
        blobs.put(pendingTerminalBlobKey(publication.run.executionId), encoded, {
          owner: publication.owner,
        }),
      ),
    );

  const removePendingTerminal = (
    publication: PendingTerminalPublication,
  ): Effect.Effect<void, StorageFailure> =>
    blobs
      .delete(pendingTerminalBlobKey(publication.run.executionId), {
        owner: publication.owner,
      })
      .pipe(
        Effect.andThen(
          terminalOutboxesC.remove({
            owner: publication.owner,
            key: publication.run.executionId,
          }),
        ),
      );

  const cleanupPublishedTerminal = (
    executionId: string,
    owner: Owner,
  ): Effect.Effect<void, StorageFailure> =>
    blobs
      .delete(pendingTerminalBlobKey(executionId), { owner })
      .pipe(Effect.andThen(terminalOutboxesC.remove({ owner, key: executionId })));

  const cleanupPublishedTerminals = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const pendingCleanup = yield* terminalOutboxesC.list();
      yield* Effect.forEach(
        pendingCleanup,
        (entry) =>
          cleanupPublishedTerminal(entry.data.executionId, entry.owner).pipe(
            Effect.retry(Schedule.recurs(2)),
            Effect.ignore,
          ),
        { concurrency: 4, discard: true },
      );
    }).pipe(Effect.retry(Schedule.recurs(2)), Effect.ignore);

  const cleanupPublishedTerminalIfMarked = (executionId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const marker = yield* terminalOutboxesC.get({ key: executionId });
      if (marker !== null) {
        yield* cleanupPublishedTerminal(executionId, marker.owner);
      }
    }).pipe(Effect.retry(Schedule.recurs(2)), Effect.ignore);

  const recoverPendingTerminal = (executionId: string): Effect.Effect<boolean, StorageFailure> =>
    Effect.gen(function* () {
      const encoded = yield* blobs.get(pendingTerminalBlobKey(executionId));
      if (encoded === null) return false;
      const publication = yield* decodePendingTerminalPublication(encoded).pipe(
        Effect.mapError(
          (cause) =>
            new StorageError({
              message: "execution-history: failed to decode pending terminal publication",
              cause,
            }),
        ),
      );
      yield* publishTerminal(publication);
      // Publication is the recovery success boundary. Cleanup is idempotent
      // and backed by the marker published above, so an unavailable blob store
      // must not make a reader return the stale nonterminal row it first read.
      yield* removePendingTerminal(publication).pipe(
        Effect.retry(Schedule.recurs(2)),
        Effect.ignore,
      );
      return true;
    }).pipe(Effect.retry(Schedule.recurs(2)));

  const recoverOutstandingTerminals = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const candidates = yield* runsC.query({
        where: { status: { in: ["running", "waiting_for_interaction"] } },
      });
      yield* Effect.forEach(
        candidates,
        (entry) => recoverPendingTerminal(entry.data.executionId).pipe(Effect.ignore),
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.ignore);

  const toolCallRowsFromBuffer = (executionId: string, buffer: RunBuffer): readonly ToolCallRow[] =>
    Array.from(buffer.toolCalls.values(), (entry) => ({
      executionId,
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
    }));

  const interactionRowsFromBuffer = (
    executionId: string,
    buffer: RunBuffer,
  ): readonly InteractionRow[] =>
    Array.from(buffer.interactions.values(), (entry) => ({
      executionId,
      interactionId: entry.interactionId,
      status: entry.status,
      kind: entry.kind,
      purpose: entry.purpose,
      payloadJson: entry.payloadJson,
      responseJson: entry.responseJson,
      errorText: entry.errorText,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    }));

  const getOrLoadBuffer = (executionId: string): Effect.Effect<RunBuffer | null, StorageFailure> =>
    Effect.gen(function* () {
      const current = buffers.get(executionId);
      if (current) return current;

      const run = yield* runsC.get({ key: executionId });
      if (run === null) return null;
      const persistedToolCalls = yield* toolCallsC.query({
        where: { executionId },
        orderBy: [{ field: "startedAt" }],
      });
      const persistedInteractions = yield* interactionsC.query({
        where: { executionId },
        orderBy: [{ field: "startedAt" }],
      });
      const buffer: RunBuffer = {
        owner: run.owner,
        startedAt: run.data.startedAt,
        code: run.data.code,
        triggerKind: run.data.triggerKind,
        triggerMetaJson: run.data.triggerMetaJson,
        hadInteraction: run.data.hadInteraction,
        toolCalls: new Map(
          persistedToolCalls.map(({ data }) => [
            data.toolCallId,
            {
              toolCallId: ExecutionToolCallId.make(data.toolCallId),
              status: data.status,
              path: data.path,
              namespace: data.namespace,
              argsJson: data.argsJson,
              resultJson: data.resultJson,
              errorText: data.errorText,
              startedAt: data.startedAt,
              completedAt: data.completedAt,
              durationMs: data.durationMs,
            },
          ]),
        ),
        interactions: new Map(
          persistedInteractions.map(({ data }) => [
            data.interactionId,
            {
              interactionId: ExecutionInteractionId.make(data.interactionId),
              status: data.status,
              kind: data.kind,
              purpose: data.purpose,
              payloadJson: data.payloadJson,
              responseJson: data.responseJson,
              errorText: data.errorText,
              startedAt: data.startedAt,
              completedAt: data.completedAt,
            },
          ]),
        ),
      };
      buffers.set(executionId, buffer);
      return buffer;
    });

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

  const onToolCallStarted = (event: Extract<ExecutionEvent, { _tag: "ToolCallStarted" }>) =>
    Effect.gen(function* () {
      const buffer = yield* getOrLoadBuffer(event.executionId);
      if (buffer === null) return;
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
    });

  const onToolCallFinished = (event: Extract<ExecutionEvent, { _tag: "ToolCallFinished" }>) =>
    Effect.gen(function* () {
      const buffer = yield* getOrLoadBuffer(event.executionId);
      if (buffer === null) return;
      const completedAt = event.completedAt.getTime();
      const existing = buffer.toolCalls.get(event.toolCallId);
      const startedAt = existing?.startedAt ?? completedAt;
      const row: ToolCallRow = {
        executionId: event.executionId,
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
      };
      buffer.toolCalls.set(event.toolCallId, { ...row, toolCallId: event.toolCallId });
      // Once a run has reached a durable waiting point, keep subsequent
      // progress restart-safe until the terminal publication lands.
      if (buffer.hadInteraction) {
        yield* toolCallsC.put({ owner: buffer.owner, key: row.toolCallId, data: row });
      }
    });

  const onInteractionStarted = (event: Extract<ExecutionEvent, { _tag: "InteractionStarted" }>) =>
    Effect.gen(function* () {
      const buffer = yield* getOrLoadBuffer(event.executionId);
      if (buffer === null) return;
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
      const waitingRun: RunRow = {
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
      };
      yield* pluginStorage.putMany({
        owner: buffer.owner,
        entries: [
          ...toolCallRowsFromBuffer(event.executionId, buffer).map((row) => ({
            collection: toolCalls.name,
            key: row.toolCallId,
            data: row,
          })),
          ...interactionRowsFromBuffer(event.executionId, buffer).map((row) => ({
            collection: interactions.name,
            key: row.interactionId,
            data: row,
          })),
          { collection: runs.name, key: event.executionId, data: waitingRun },
        ],
      });
    }).pipe(Effect.retry(Schedule.recurs(2)));

  const onInteractionResolved = (event: Extract<ExecutionEvent, { _tag: "InteractionResolved" }>) =>
    Effect.gen(function* () {
      const buffer = yield* getOrLoadBuffer(event.executionId);
      if (buffer === null) return;
      const existing = buffer.interactions.get(event.interactionId);
      const row: InteractionRow = {
        executionId: event.executionId,
        interactionId: event.interactionId,
        status: event.status,
        kind: existing?.kind ?? "unknown",
        purpose: existing?.purpose ?? null,
        payloadJson: existing?.payloadJson ?? null,
        responseJson: toJson(event.response),
        errorText: event.error ?? null,
        startedAt: existing?.startedAt ?? event.completedAt.getTime(),
        completedAt: event.completedAt.getTime(),
      };
      buffer.interactions.set(event.interactionId, {
        ...row,
        interactionId: event.interactionId,
      });
      yield* interactionsC.put({ owner: buffer.owner, key: row.interactionId, data: row });
    });

  const onExecutionFinished = (event: Extract<ExecutionEvent, { _tag: "ExecutionFinished" }>) =>
    Effect.gen(function* () {
      const buffer = yield* getOrLoadBuffer(event.executionId);
      const owner = buffer?.owner ?? ownerOf(event.owner);
      const completedAt = event.completedAt.getTime();
      const toolCallEntries = buffer ? toolCallRowsFromBuffer(event.executionId, buffer) : [];
      const interactionEntries = buffer ? interactionRowsFromBuffer(event.executionId, buffer) : [];
      // Preserve code/trigger/startedAt from the buffer, or from the persisted
      // "running" row if the buffer was lost (e.g. a restart mid-run).
      const existing = yield* runsC.get({ key: event.executionId });
      const code = buffer?.code ?? existing?.data.code ?? "";
      const triggerKind = buffer?.triggerKind ?? existing?.data.triggerKind ?? null;
      const triggerMetaJson = buffer?.triggerMetaJson ?? existing?.data.triggerMetaJson ?? null;
      const startedAt = buffer?.startedAt ?? existing?.data.startedAt ?? completedAt;
      const hadInteraction =
        buffer?.hadInteraction ?? (existing?.data.hadInteraction || interactionEntries.length > 0);

      const terminalRun: RunRow = {
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
      };

      const publication: PendingTerminalPublication = {
        owner,
        run: terminalRun,
        toolCalls: toolCallEntries,
        interactions: interactionEntries,
      };

      // Observer failures are isolated from the engine. If the eager started
      // write failed, establish a nonterminal recovery anchor before creating
      // the outbox; reads can then discover and replay that blob after restart.
      if (existing === null) {
        yield* putRun(owner, {
          ...terminalRun,
          status: "running",
          resultJson: null,
          errorText: null,
          logsJson: null,
          completedAt: null,
          durationMs: null,
        });
      }

      // The blob is a durable outbox. Once it exists, a later read can replay
      // this idempotent publication after a restart or exhausted retry budget.
      // If the outbox store is unavailable, continue to the atomic database
      // publication directly instead of losing the completed execution.
      yield* writePendingTerminal(publication).pipe(Effect.catch(() => Effect.void));
      // One bulk upsert is the terminal commit point: the run and all of its
      // normalized detail rows become visible together, so readers can never
      // observe a terminal count without the corresponding records.
      yield* publishTerminal(publication);
      // The terminal batch above is the commit point. Cleanup is retryable via
      // its durable marker and must not report a committed history write as a
      // failure merely because the blob store is temporarily unavailable.
      yield* removePendingTerminal(publication).pipe(
        Effect.retry(Schedule.recurs(2)),
        Effect.ignore,
      );
    }).pipe(
      // The observer boundary logs and isolates failures, so retry transient
      // storage faults here. Repeated puts are idempotent by collection key.
      Effect.retry(Schedule.recurs(2)),
      // Keep the live buffer until the durable outbox has been published and
      // removed. Once written, that outbox also survives process restarts.
      Effect.tap(() => Effect.sync(() => buffers.delete(event.executionId))),
    );

  const handleEvent = (event: ExecutionEvent): Effect.Effect<void, StorageFailure> => {
    if (Predicate.isTagged(event, "ExecutionStarted")) return onExecutionStarted(event);
    if (Predicate.isTagged(event, "ToolCallStarted")) return onToolCallStarted(event);
    if (Predicate.isTagged(event, "ToolCallFinished")) return onToolCallFinished(event);
    if (Predicate.isTagged(event, "InteractionStarted")) return onInteractionStarted(event);
    if (Predicate.isTagged(event, "InteractionResolved")) return onInteractionResolved(event);
    // Explicit guard, not a fallthrough: a future ExecutionEvent variant must
    // not be silently recorded as a finished run.
    if (Predicate.isTagged(event, "ExecutionFinished")) return onExecutionFinished(event);
    return Effect.void;
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
      // Drain the durable outbox independently of the caller's filters and
      // page so a completed run cannot remain hidden as nonterminal.
      yield* cleanupPublishedTerminals();
      yield* recoverOutstandingTerminals();
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
      let run = yield* runsC.get({ key: executionId });
      if (run === null) return null;
      const recovered = isNonterminalRun(run.data)
        ? yield* recoverPendingTerminal(executionId).pipe(Effect.orElseSucceed(() => false))
        : false;
      if (recovered) {
        run = yield* runsC.get({ key: executionId });
        if (run === null) return null;
      }
      if (!isNonterminalRun(run.data)) {
        yield* cleanupPublishedTerminalIfMarked(executionId);
      }
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
    Effect.gen(function* () {
      const run = yield* runsC.get({ key: executionId });
      if (run !== null && isNonterminalRun(run.data)) {
        yield* recoverPendingTerminal(executionId).pipe(Effect.ignore);
      } else if (run !== null) {
        yield* cleanupPublishedTerminalIfMarked(executionId);
      }
      const rows = yield* toolCallsC.query({
        where: { executionId },
        orderBy: [{ field: "startedAt" }],
      });
      return rows.map((entry) => entry.data);
    });

  return { handleEvent, list, get, listToolCalls };
};

/** Build an ExecutionObserver over a store instance — every engine event is
 *  forwarded to the store's buffered-batch writer. */
export const makeExecutionHistoryObserver = (
  store: Pick<ExecutionHistoryStore, "handleEvent">,
): ExecutionObserver<StorageFailure> => ({
  handle: (event) => store.handleEvent(event),
});
