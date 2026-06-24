import { Effect, Match, Option, Predicate, Schema } from "effect";

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
  StorageError,
} from "@executor-js/sdk/core";

import {
  type InteractionRow,
  type InteractionStatus,
  type RunRow,
  type ToolCallRow,
  type ToolCallStatus,
  RunStatus,
  runs,
} from "./collections";
import { type RunDetail, RunDetailFromJsonString } from "./detail-types";

// ---------------------------------------------------------------------------
// Execution-history store. Translates the engine's ExecutionEvent stream into a
// slim D1 `runs` index row + an append-only R2 detail object, and exposes the
// read surface.
//
// Storage split:
// - D1 `runs` row (via pluginStorage): slim, indexed, list-renderable — status,
//   trigger, actor, timing, counts, plus `codePreview` and `logErrorCount`/
//   `logWarnCount` so the list never fetches a blob.
// - R2 detail object (via `deps.blobs`, keyed `run-detail/<executionId>`): the
//   bulky drawer-only payload — full code, result/error/logs/trigger-metadata,
//   and the per-tool-call / per-interaction rows. Written once.
//
// Write model — buffered batch: tool-call and interaction detail is held in an
// in-memory buffer keyed by executionId and flushed into the R2 detail object
// when the execution finishes. Eager writes for durability: on ExecutionStarted
// the slim "running" row AND a code-only stub detail blob (so a live/paused run
// shows its code immediately and survives a restart); on InteractionStarted the
// "waiting_for_interaction" row.
//
// Every `unknown` payload is serialized to a JSON string via Effect Schema
// (`Schema.UnknownFromJsonString`); the detail object round-trips via
// `Schema.fromJsonString` — no raw `JSON.stringify`/`JSON.parse` in domain code.
// ---------------------------------------------------------------------------

/** Serialize an arbitrary value to a JSON string, or null when absent or when
 *  the value isn't JSON-encodable (encoding never throws). */
const encodeUnknownJson = Schema.encodeUnknownOption(Schema.UnknownFromJsonString);

const toJson = (value: unknown): string | null =>
  value === undefined ? null : Option.getOrNull(encodeUnknownJson(value));

const ownerOf = (binding: OwnerBinding): Owner => (binding.subject != null ? "user" : "org");

/** Hoisted: `Schema.is` compiles a guard, so it must not be rebuilt per row. */
const isRunStatus = Schema.is(RunStatus);

const MAX_INTERACTION_ARG_KEYS = 25;
const MAX_INTERACTION_STRING_CHARS = 300;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const previewScalar = (value: unknown): unknown => {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length > MAX_INTERACTION_STRING_CHARS
      ? `${value.slice(0, MAX_INTERACTION_STRING_CHARS)}...`
      : value;
  }
  if (Array.isArray(value)) return `[Array(${value.length})]`;
  if (isRecord(value)) return `[Object(${Object.keys(value).length})]`;
  return `[${typeof value}]`;
};

const argsPreviewOf = (args: unknown): unknown => {
  if (!isRecord(args)) return previewScalar(args);
  const entries = Object.entries(args).slice(0, MAX_INTERACTION_ARG_KEYS);
  const preview: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    preview[key] = previewScalar(value);
  }
  const omitted = Object.keys(args).length - entries.length;
  return omitted > 0 ? { ...preview, __omittedKeys: omitted } : preview;
};

const interactionPayloadOf = (
  context: Extract<ExecutionEvent, { _tag: "InteractionStarted" }>["context"],
) => {
  const request = context.request;
  if (Predicate.isTagged(request, "UrlElicitation")) {
    return {
      address: String(context.address),
      argsPreview: argsPreviewOf(context.args),
      request: {
        kind: "UrlElicitation",
        message: request.message,
        url: request.url,
        elicitationId: request.elicitationId,
      },
    };
  }

  return {
    address: String(context.address),
    argsPreview: argsPreviewOf(context.args),
    request: {
      kind: "FormElicitation",
      message: request.message,
      requestedSchema: request.requestedSchema,
    },
  };
};

/** First dot-delimited segment of a tool path (its namespace), or null. */
const namespaceOf = (path: string): string | null => {
  const index = path.indexOf(".");
  return index > 0 ? path.slice(0, index) : null;
};

/** Bounded, whitespace-normalized snippet of the code for the list column. The
 *  full code lives in the R2 detail object. */
const codePreviewOf = (code: string): string => code.trim().replace(/\s+/g, " ").slice(0, 256);

/** Count `[error]` / `[warn]` log lines (case-insensitive substring, counted
 *  independently — matches the list's prior logsJson parsing) so the list reads
 *  precomputed scalars instead of fetching + parsing the full logs from R2. */
const logCountsOf = (logs: unknown): { errors: number; warns: number } => {
  if (!Array.isArray(logs)) return { errors: 0, warns: 0 };
  let errors = 0;
  let warns = 0;
  for (const line of logs) {
    if (typeof line !== "string") continue;
    const lower = line.toLowerCase();
    if (lower.includes("[error]")) errors += 1;
    if (lower.includes("[warn]")) warns += 1;
  }
  return { errors, warns };
};

/** R2 blob key for a run's detail object. */
const detailBlobKey = (executionId: string): string => `run-detail/${executionId}`;

/** Detail codec helpers (Schema-based; never raw JSON). Encode runs in the
 *  Effect channel so a (never-in-practice) failure maps to a typed StorageError
 *  rather than a `die`; decode reads gracefully as an `Option`. */
const encodeDetail = Schema.encodeUnknownEffect(RunDetailFromJsonString);
const decodeDetail = Schema.decodeUnknownOption(RunDetailFromJsonString);

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
  // terminal) keeps the code + trigger + actor — later events don't carry them.
  code: string;
  triggerKind: string | null;
  triggerMetaJson: string | null;
  actorId: string | null;
  actorLabel: string | null;
  actorKind: string | null;
  hadInteraction: boolean;
  hadFormApproval: boolean;
  hadUrlApproval: boolean;
  toolCalls: Map<string, BufferedToolCall>;
  interactions: Map<string, BufferedInteraction>;
}

// ---------------------------------------------------------------------------
// Read-surface option/result types.
//
// The list surface is keyset-paginated and carries an aggregate `meta` block
// (facet counts, a stacked-by-status timeline, and duration percentiles) that
// the runs UI renders. All of it is pushed down to SQL through the plugin
// storage `aggregate`/`queryKeyset` facade — no whole-collection scans in JS.
// `meta` is computed only on the initial page (no cursor, no live `after`),
// matching how the UI fetches it once per filter set.
// ---------------------------------------------------------------------------

export type RunsSortField = "startedAt" | "durationMs";
export type ApprovalTypeFilter = "form" | "url";

/** Opaque-to-the-client keyset cursor: the sort value + storage key of the last
 *  row on a page. The HTTP layer encodes/decodes it as a string. */
export interface RunsCursor {
  readonly sort: number | null;
  readonly key: string;
}

export interface ExecutionHistoryListOptions {
  readonly statusFilter?: readonly RunStatus[];
  readonly triggerFilter?: readonly string[];
  readonly actorFilter?: readonly string[];
  readonly timeRange?: { readonly from?: number; readonly to?: number };
  readonly hadInteraction?: boolean;
  readonly approvalType?: ApprovalTypeFilter;
  /** Live-tail floor: only runs whose `startedAt` is strictly greater. */
  readonly after?: number;
  readonly sortField?: RunsSortField;
  readonly sortDirection?: "asc" | "desc";
  readonly limit: number;
  readonly cursor?: RunsCursor;
}

export interface RunStatusCount {
  readonly status: RunStatus;
  readonly count: number;
}

export interface RunTriggerCount {
  readonly triggerKind: string | null;
  readonly count: number;
}

export interface RunActorCount {
  readonly actorId: string | null;
  /** A display label for the actor (the most-recent run's snapshot), or null. */
  readonly actorLabel: string | null;
  readonly actorKind: string | null;
  readonly count: number;
}

export interface RunInteractionCounts {
  readonly withInteraction: number;
  readonly withoutInteraction: number;
  readonly formApproval: number;
  readonly urlApproval: number;
}

export interface RunChartBucket {
  readonly bucketStart: number;
  /** Status -> run count for the bucket; absent statuses are omitted. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface RunDurationStats {
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

export interface ExecutionListMeta {
  readonly totalRowCount: number;
  readonly filterRowCount: number;
  readonly statusCounts: readonly RunStatusCount[];
  readonly triggerCounts: readonly RunTriggerCount[];
  readonly actorCounts: readonly RunActorCount[];
  readonly interactionCounts: RunInteractionCounts;
  readonly chartBucketMs: number;
  readonly chartData: readonly RunChartBucket[];
  readonly durationStats: RunDurationStats;
}

export interface ExecutionHistoryListResult {
  readonly runs: readonly RunRow[];
  readonly nextCursor: RunsCursor | null;
  readonly meta: ExecutionListMeta | null;
}

export interface ExecutionHistoryDetail {
  readonly run: RunRow;
  /** Bulky drawer payload, sourced from the R2 detail object (flat-merged onto
   *  the slim run row). For in-flight or detail-less runs these are the
   *  stub/empty values. */
  readonly code: string;
  readonly resultJson: string | null;
  readonly errorText: string | null;
  readonly logsJson: string | null;
  readonly triggerMetaJson: string | null;
  readonly toolCalls: readonly ToolCallRow[];
  readonly interactions: readonly InteractionRow[];
}

export interface ExecutionHistoryStore {
  readonly handleEvent: (event: ExecutionEvent) => Effect.Effect<void, StorageFailure>;
  readonly list: (
    options: ExecutionHistoryListOptions,
  ) => Effect.Effect<ExecutionHistoryListResult, StorageFailure>;
  readonly get: (
    executionId: string,
  ) => Effect.Effect<ExecutionHistoryDetail | null, StorageFailure>;
}

// ---------------------------------------------------------------------------
// List helpers (pure).
// ---------------------------------------------------------------------------

type RunsWhere = {
  status?: { in: readonly RunStatus[] };
  triggerKind?: { in: readonly string[] };
  actorId?: { in: readonly string[] };
  startedAt?: { gte?: number; lte?: number; gt?: number };
  hadInteraction?: { eq: boolean };
  hadFormApproval?: { eq: boolean };
  hadUrlApproval?: { eq: boolean };
};

/** Build the indexed-field `where` from list options. `omit` drops one facet's
 *  own field so a facet count reflects the *other* filters (a faceted rail still
 *  shows every option for the field you're filtering on). */
const buildRunsWhere = (
  options: ExecutionHistoryListOptions,
  omit?: "status" | "triggerKind" | "actorId" | "hadInteraction" | "approvalType",
): RunsWhere => {
  const where: RunsWhere = {};
  if (omit !== "status" && options.statusFilter && options.statusFilter.length > 0) {
    where.status = { in: options.statusFilter };
  }
  if (omit !== "triggerKind" && options.triggerFilter && options.triggerFilter.length > 0) {
    where.triggerKind = { in: options.triggerFilter };
  }
  if (omit !== "actorId" && options.actorFilter && options.actorFilter.length > 0) {
    where.actorId = { in: options.actorFilter };
  }
  const startedAt: { gte?: number; lte?: number; gt?: number } = {};
  if (options.timeRange?.from != null) startedAt.gte = options.timeRange.from;
  if (options.timeRange?.to != null) startedAt.lte = options.timeRange.to;
  if (options.after != null) startedAt.gt = options.after;
  if (Object.keys(startedAt).length > 0) where.startedAt = startedAt;
  if (omit !== "hadInteraction" && options.hadInteraction != null) {
    where.hadInteraction = { eq: options.hadInteraction };
  }
  if (omit !== "approvalType") {
    if (options.approvalType === "form") where.hadFormApproval = { eq: true };
    if (options.approvalType === "url") where.hadUrlApproval = { eq: true };
  }
  return where;
};

const HOUR_MS = 3_600_000;
const BUCKET_STEPS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  HOUR_MS,
  6 * HOUR_MS,
  24 * HOUR_MS,
  7 * 24 * HOUR_MS,
] as const;

/** Pick a timeline bucket width (~48 buckets across the requested range). */
const chooseBucketMs = (timeRange: { from?: number; to?: number } | undefined): number => {
  if (timeRange?.from == null || timeRange.to == null) return HOUR_MS;
  const target = Math.max(1, timeRange.to - timeRange.from) / 48;
  return (
    BUCKET_STEPS_MS.find((step) => step >= target) ?? BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1]!
  );
};

export const makeExecutionHistoryStore = (deps: StorageDeps): ExecutionHistoryStore => {
  const pluginStorage: PluginStorageFacade = deps.pluginStorage;
  const runsC: PluginStorageCollectionFacade<typeof runs> = pluginStorage.collection(runs);
  const blobs = deps.blobs;

  const buffers = new Map<string, RunBuffer>();

  const putRun = (owner: Owner, row: RunRow): Effect.Effect<void, StorageFailure> =>
    runsC.put({ owner, key: row.executionId, data: row }).pipe(Effect.asVoid);

  /** Write the run's R2 detail object. A (never-in-practice) encode failure maps
   *  to a typed StorageError so it stays in the storage error channel. */
  const putDetail = (
    owner: Owner,
    executionId: string,
    detail: RunDetail,
  ): Effect.Effect<void, StorageFailure> =>
    encodeDetail(detail).pipe(
      Effect.mapError(
        (cause) =>
          new StorageError({ message: "execution-history: failed to encode run detail", cause }),
      ),
      Effect.flatMap((json) => blobs.put(detailBlobKey(executionId), json, { owner })),
    );

  /** Read + decode the run's R2 detail object; `None` when absent or malformed. */
  const readDetail = (
    executionId: string,
  ): Effect.Effect<Option.Option<RunDetail>, StorageFailure> =>
    blobs
      .get(detailBlobKey(executionId))
      .pipe(Effect.map((raw) => (raw === null ? Option.none<RunDetail>() : decodeDetail(raw))));

  const onExecutionStarted = (event: Extract<ExecutionEvent, { _tag: "ExecutionStarted" }>) => {
    const owner = ownerOf(event.owner);
    const startedAt = event.startedAt.getTime();
    const triggerKind = event.trigger?.kind ?? null;
    const triggerMetaJson = toJson(event.trigger?.metadata);
    const actor = event.trigger?.actor;
    const actorId = actor?.id ?? null;
    const actorLabel = actor?.label ?? null;
    const actorKind = actor?.kind ?? null;
    buffers.set(event.executionId, {
      owner,
      startedAt,
      code: event.code,
      triggerKind,
      triggerMetaJson,
      actorId,
      actorLabel,
      actorKind,
      hadInteraction: false,
      hadFormApproval: false,
      hadUrlApproval: false,
      toolCalls: new Map(),
      interactions: new Map(),
    });
    return Effect.all(
      [
        putRun(owner, {
          executionId: event.executionId,
          status: "running",
          codePreview: codePreviewOf(event.code),
          triggerKind,
          logErrorCount: 0,
          logWarnCount: 0,
          actorId,
          actorLabel,
          actorKind,
          startedAt,
          completedAt: null,
          durationMs: null,
          toolCallCount: 0,
          hadInteraction: false,
          hadFormApproval: false,
          hadUrlApproval: false,
        }),
        // Eager code-only stub: the drawer shows code while the run is live, and
        // the code survives a restart that loses the in-memory buffer.
        putDetail(owner, event.executionId, {
          code: event.code,
          resultJson: null,
          errorText: null,
          logsJson: null,
          triggerMetaJson,
          toolCalls: [],
          interactions: [],
        }),
      ],
      { concurrency: "unbounded", discard: true },
    );
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
    const isUrlApproval = kind === "UrlElicitation";
    const isFormApproval = kind === "FormElicitation";
    buffer.interactions.set(event.interactionId, {
      interactionId: event.interactionId,
      status: "pending",
      kind,
      purpose: request.message,
      payloadJson: toJson(interactionPayloadOf(event.context)),
      responseJson: null,
      errorText: null,
      startedAt: event.startedAt.getTime(),
      completedAt: null,
    });
    buffer.hadInteraction = true;
    buffer.hadFormApproval = buffer.hadFormApproval || isFormApproval;
    buffer.hadUrlApproval = buffer.hadUrlApproval || isUrlApproval;
    return putRun(buffer.owner, {
      executionId: event.executionId,
      status: "waiting_for_interaction",
      codePreview: codePreviewOf(buffer.code),
      triggerKind: buffer.triggerKind,
      logErrorCount: 0,
      logWarnCount: 0,
      actorId: buffer.actorId,
      actorLabel: buffer.actorLabel,
      actorKind: buffer.actorKind,
      startedAt: buffer.startedAt,
      completedAt: null,
      durationMs: null,
      toolCallCount: buffer.toolCalls.size,
      hadInteraction: true,
      hadFormApproval: buffer.hadFormApproval,
      hadUrlApproval: buffer.hadUrlApproval,
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
    const { errors: logErrorCount, warns: logWarnCount } = logCountsOf(event.logs);

    return Effect.gen(function* () {
      // Recover slim fields from the persisted "running" row if the buffer was
      // lost (restart mid-run). Full code/trigger-metadata live only in the
      // buffer + the start-stub blob.
      const existing = buffer ? null : yield* runsC.get({ key: event.executionId });
      const triggerKind = buffer?.triggerKind ?? existing?.data.triggerKind ?? null;
      const actorId = buffer?.actorId ?? existing?.data.actorId ?? null;
      const actorLabel = buffer?.actorLabel ?? existing?.data.actorLabel ?? null;
      const actorKind = buffer?.actorKind ?? existing?.data.actorKind ?? null;
      const startedAt = buffer?.startedAt ?? existing?.data.startedAt ?? completedAt;
      const codePreview = buffer ? codePreviewOf(buffer.code) : (existing?.data.codePreview ?? "");
      const hadInteraction =
        buffer?.hadInteraction ?? (existing?.data.hadInteraction || interactionEntries.length > 0);
      const hadFormApproval =
        buffer?.hadFormApproval ??
        existing?.data.hadFormApproval ??
        interactionEntries.some((entry) => entry.kind === "FormElicitation");
      const hadUrlApproval =
        buffer?.hadUrlApproval ??
        existing?.data.hadUrlApproval ??
        interactionEntries.some((entry) => entry.kind === "UrlElicitation");

      yield* putRun(owner, {
        executionId: event.executionId,
        status: event.status,
        codePreview,
        triggerKind,
        logErrorCount,
        logWarnCount,
        actorId,
        actorLabel,
        actorKind,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        toolCallCount: toolCallEntries.length,
        hadInteraction,
        hadFormApproval,
        hadUrlApproval,
      });

      // Write the full detail object. Normal path: assembled from the buffer.
      // Buffer-lost path: preserve the start-stub's code + trigger-metadata and
      // attach the terminal result/error/logs (per-call children are
      // unrecoverable after a restart).
      const detail: RunDetail = buffer
        ? {
            code: buffer.code,
            resultJson: toJson(event.result),
            errorText: event.error ?? null,
            logsJson: toJson(event.logs),
            triggerMetaJson: buffer.triggerMetaJson,
            toolCalls: toolCallEntries.map((entry) => ({
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
            })),
            interactions: interactionEntries.map((entry) => ({
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
            })),
          }
        : yield* readDetail(event.executionId).pipe(
            Effect.map((stubOpt) => {
              const stub = Option.getOrNull(stubOpt);
              return {
                code: stub?.code ?? "",
                resultJson: toJson(event.result),
                errorText: event.error ?? null,
                logsJson: toJson(event.logs),
                triggerMetaJson: stub?.triggerMetaJson ?? null,
                toolCalls: [],
                interactions: [],
              };
            }),
          );

      yield* putDetail(owner, event.executionId, detail);
    }).pipe(
      // Always release the buffer, even if a write fails or is interrupted —
      // otherwise a StorageFailure during the flush leaks the RunBuffer forever.
      Effect.ensuring(Effect.sync(() => buffers.delete(event.executionId))),
    );
  };

  const handleEvent = Match.type<ExecutionEvent>().pipe(
    Match.withReturnType<Effect.Effect<void, StorageFailure>>(),
    Match.tag("ExecutionStarted", onExecutionStarted),
    Match.tag("ToolCallStarted", onToolCallStarted),
    Match.tag("ToolCallFinished", onToolCallFinished),
    Match.tag("InteractionStarted", onInteractionStarted),
    Match.tag("InteractionResolved", onInteractionResolved),
    Match.tag("ExecutionFinished", onExecutionFinished),
    Match.exhaustive,
  );

  const computeMeta = (
    options: ExecutionHistoryListOptions,
  ): Effect.Effect<ExecutionListMeta, StorageFailure> =>
    Effect.gen(function* () {
      const where = buildRunsWhere(options);

      // Wave 1: all independent aggregates concurrently.
      const [
        totalRowCount,
        filterRowCount,
        statusGroups,
        triggerGroups,
        actorGroups,
        interactionGroups,
        formApprovalCount,
        urlApprovalCount,
        stats,
        startedAtStats,
      ] = yield* Effect.all(
        [
          runsC.aggregate.count(),
          runsC.aggregate.count({ where }),
          runsC.aggregate.groupCount({
            field: "status",
            where: buildRunsWhere(options, "status"),
          }),
          runsC.aggregate.groupCount({
            field: "triggerKind",
            where: buildRunsWhere(options, "triggerKind"),
          }),
          runsC.aggregate.groupCount({
            field: "actorId",
            where: buildRunsWhere(options, "actorId"),
          }),
          runsC.aggregate.groupCount({
            field: "hadInteraction",
            where: buildRunsWhere(options, "hadInteraction"),
            valueType: "boolean",
          }),
          runsC.aggregate.count({
            where: { ...buildRunsWhere(options, "approvalType"), hadFormApproval: { eq: true } },
          }),
          runsC.aggregate.count({
            where: { ...buildRunsWhere(options, "approvalType"), hadUrlApproval: { eq: true } },
          }),
          runsC.aggregate.stats({
            field: "durationMs",
            where,
            percentiles: [0.5, 0.75, 0.9, 0.95, 0.99],
          }),
          runsC.aggregate.stats({
            field: "startedAt",
            where,
            percentiles: [],
          }),
        ] as const,
        { concurrency: "unbounded" },
      );

      const statusCounts: RunStatusCount[] = [];
      for (const group of statusGroups) {
        if (isRunStatus(group.value)) {
          statusCounts.push({ status: group.value, count: group.count });
        }
      }

      // Wave 2: stacked-by-status timeline — one bucketed count per present
      // status, merged by bucket start. Respects every filter except `status`
      // itself. Per-status queries are independent so run concurrently.
      //
      // When no explicit time range is set, derive the bucketing span from the
      // data's actual startedAt min/max so the bucket count stays ~48 regardless
      // of dataset age. Falls back to chooseBucketMs default only when the
      // result set is empty (startedAtStats.min/max are null).
      const effectiveBucketRange: { from?: number; to?: number } =
        options.timeRange?.from != null && options.timeRange.to != null
          ? options.timeRange
          : {
              from: startedAtStats.min ?? undefined,
              to: startedAtStats.max ?? undefined,
            };
      const bucketMs = chooseBucketMs(effectiveBucketRange);
      const chartWhere = buildRunsWhere(options, "status");
      const perStatusBuckets = yield* Effect.forEach(
        statusCounts,
        (entry) =>
          runsC.aggregate
            .timeBuckets({
              field: "startedAt",
              bucketMs,
              where: { ...chartWhere, status: { in: [entry.status] } },
            })
            .pipe(Effect.map((buckets) => ({ status: entry.status, buckets }))),
        { concurrency: "unbounded" },
      );
      const chartByBucket = new Map<number, Record<string, number>>();
      for (const { status, buckets } of perStatusBuckets) {
        for (const bucket of buckets) {
          const counts = chartByBucket.get(bucket.bucket) ?? {};
          counts[status] = bucket.count;
          chartByBucket.set(bucket.bucket, counts);
        }
      }
      const chartData: RunChartBucket[] = [...chartByBucket.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([bucketStart, counts]) => ({ bucketStart, counts }));

      const triggerCounts: RunTriggerCount[] = triggerGroups.map((group) => ({
        triggerKind: typeof group.value === "string" ? group.value : null,
        count: group.count,
      }));

      // Resolve a display label + kind per actor. The facet keys on the STABLE
      // `actorId`, but renders the human snapshot (`actorLabel`/`actorKind`) from
      // that actor's most-recent run WITHIN the current filter window — so the
      // label stays consistent with the (filtered) count shown beside it, rather
      // than a globally-newest snapshot that could predate the window. One query
      // per distinct actor; the null-actor group needs no lookup.
      const actorFacetWhere = buildRunsWhere(options, "actorId");
      const actorIds = actorGroups
        .map((group) => (typeof group.value === "string" ? group.value : null))
        .filter(Predicate.isNotNull);
      const actorMeta = yield* Effect.forEach(
        actorIds,
        (actorId) =>
          runsC
            .query({
              where: { ...actorFacetWhere, actorId: { in: [actorId] } },
              orderBy: [{ field: "startedAt", direction: "desc" }],
              limit: 1,
            })
            .pipe(
              Effect.map((rows) => ({
                actorId,
                label: rows[0]?.data.actorLabel ?? null,
                kind: rows[0]?.data.actorKind ?? null,
              })),
            ),
        // Cap the burst: distinct-actor cardinality is normally small, but a
        // workspace with many service tokens shouldn't fan out unboundedly.
        { concurrency: 10 },
      );
      const actorMetaById = new Map(actorMeta.map((entry) => [entry.actorId, entry]));
      const actorCounts: RunActorCount[] = actorGroups.map((group) => {
        const actorId = typeof group.value === "string" ? group.value : null;
        const resolved = actorId !== null ? actorMetaById.get(actorId) : undefined;
        return {
          actorId,
          actorLabel: resolved?.label ?? null,
          actorKind: resolved?.kind ?? null,
          count: group.count,
        };
      });
      const withInteraction = interactionGroups.find((group) => group.value === true)?.count ?? 0;
      const withoutInteraction =
        interactionGroups.find((group) => group.value === false)?.count ?? 0;
      const percentileAt = (fraction: number): number | null =>
        stats.percentiles.find((entry) => entry.fraction === fraction)?.value ?? null;

      return {
        totalRowCount,
        filterRowCount,
        statusCounts,
        triggerCounts,
        actorCounts,
        interactionCounts: {
          withInteraction,
          withoutInteraction,
          formApproval: formApprovalCount,
          urlApproval: urlApprovalCount,
        },
        chartBucketMs: bucketMs,
        chartData,
        durationStats: {
          count: stats.count,
          min: stats.min,
          max: stats.max,
          p50: percentileAt(0.5),
          p75: percentileAt(0.75),
          p90: percentileAt(0.9),
          p95: percentileAt(0.95),
          p99: percentileAt(0.99),
        },
      };
    });

  const list = (
    options: ExecutionHistoryListOptions,
  ): Effect.Effect<ExecutionHistoryListResult, StorageFailure> =>
    Effect.gen(function* () {
      const sortField = options.sortField ?? "startedAt";
      const sortDirection = options.sortDirection ?? "desc";
      const where = buildRunsWhere(options);
      const page = yield* runsC.queryKeyset({
        where,
        orderBy: [{ field: sortField, direction: sortDirection, valueType: "number" }],
        limit: options.limit,
        cursor: options.cursor
          ? { values: [options.cursor.sort], key: options.cursor.key }
          : undefined,
      });
      const nextCursor: RunsCursor | null = page.nextCursor
        ? {
            sort: typeof page.nextCursor.values[0] === "number" ? page.nextCursor.values[0] : null,
            key: page.nextCursor.key,
          }
        : null;
      // Meta is computed once per filter set — only for the first page, and
      // never during live polling (`after`).
      const meta =
        options.cursor === undefined && options.after === undefined
          ? yield* computeMeta(options)
          : null;
      return { runs: page.entries.map((entry) => entry.data), nextCursor, meta };
    });

  const get = (executionId: string): Effect.Effect<ExecutionHistoryDetail | null, StorageFailure> =>
    Effect.gen(function* () {
      const run = yield* runsC.get({ key: executionId });
      if (run === null) return null;
      // Detail comes from the R2 object. Absent/malformed (or an in-flight run
      // whose stub is gone) → empty detail so the drawer still renders the row.
      const detail = Option.getOrNull(yield* readDetail(executionId));
      return {
        run: run.data,
        code: detail?.code ?? "",
        resultJson: detail?.resultJson ?? null,
        errorText: detail?.errorText ?? null,
        logsJson: detail?.logsJson ?? null,
        triggerMetaJson: detail?.triggerMetaJson ?? null,
        toolCalls: detail?.toolCalls ?? [],
        interactions: detail?.interactions ?? [],
      };
    });

  return { handleEvent, list, get };
};

/** Build an ExecutionObserver over a store instance — every engine event is
 *  forwarded to the store's buffered-batch writer. */
export const makeExecutionHistoryObserver = (
  store: Pick<ExecutionHistoryStore, "handleEvent">,
): ExecutionObserver<StorageFailure> => ({
  handle: (event) => store.handleEvent(event),
});
