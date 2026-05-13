import { Effect, Predicate, Schema } from "effect";
import {
  defineSchema,
  type ExecutionEvent,
  type ExecutionId,
  type ExecutionObserver,
  type ScopeId,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";
import type { InferDBFieldsOutput } from "@executor-js/storage-core";

export const executionHistorySchema = defineSchema({
  execution_history_run: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      status: { type: ["running", "completed", "failed"], required: true },
      code: { type: "string", required: true },
      result_json: { type: "string", required: false },
      error_text: { type: "string", required: false },
      logs_json: { type: "string", required: false },
      started_at: { type: "number", required: true, index: true },
      completed_at: { type: "number", required: false },
      trigger_kind: { type: "string", required: false, index: true },
      trigger_meta_json: { type: "string", required: false },
      tool_call_count: { type: "number", required: true },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  execution_history_tool_call: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      execution_id: { type: "string", required: true, index: true },
      status: { type: ["running", "completed", "failed"], required: true },
      tool_path: { type: "string", required: true, index: true },
      namespace: { type: "string", required: false },
      args_json: { type: "string", required: false },
      result_json: { type: "string", required: false },
      error_text: { type: "string", required: false },
      started_at: { type: "number", required: true },
      completed_at: { type: "number", required: false },
      duration_ms: { type: "number", required: false },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  execution_history_interaction: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      execution_id: { type: "string", required: true, index: true },
      status: { type: ["pending", "accepted", "declined", "cancelled", "failed"], required: true },
      kind: { type: "string", required: true },
      purpose: { type: "string", required: false },
      payload_json: { type: "string", required: false },
      response_json: { type: "string", required: false },
      error_text: { type: "string", required: false },
      started_at: { type: "number", required: true },
      completed_at: { type: "number", required: false },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
});

export type ExecutionHistorySchema = typeof executionHistorySchema;
type RunRow = InferDBFieldsOutput<ExecutionHistorySchema["execution_history_run"]["fields"]> &
  Record<string, unknown>;
type ToolCallRow = InferDBFieldsOutput<
  ExecutionHistorySchema["execution_history_tool_call"]["fields"]
> &
  Record<string, unknown>;
type InteractionRow = InferDBFieldsOutput<
  ExecutionHistorySchema["execution_history_interaction"]["fields"]
> &
  Record<string, unknown>;

export const ExecutionHistoryRunStatus = Schema.Literals(["running", "completed", "failed"]);
export type ExecutionHistoryRunStatus = typeof ExecutionHistoryRunStatus.Type;

export const EXECUTION_HISTORY_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
] as const satisfies readonly ExecutionHistoryRunStatus[];

export const ExecutionHistoryInteractionStatus = Schema.Literals([
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "failed",
]);
export type ExecutionHistoryInteractionStatus = typeof ExecutionHistoryInteractionStatus.Type;

export const ExecutionHistoryToolCallStatus = Schema.Literals(["running", "completed", "failed"]);
export type ExecutionHistoryToolCallStatus = typeof ExecutionHistoryToolCallStatus.Type;

export const ExecutionHistoryRun = Schema.Struct({
  id: Schema.String,
  scopeId: Schema.String,
  status: ExecutionHistoryRunStatus,
  code: Schema.String,
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  logsJson: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  triggerKind: Schema.NullOr(Schema.String),
  triggerMetaJson: Schema.NullOr(Schema.String),
  toolCallCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ExecutionHistoryRun = typeof ExecutionHistoryRun.Type;

export const ExecutionHistoryInteraction = Schema.Struct({
  id: Schema.String,
  executionId: Schema.String,
  status: ExecutionHistoryInteractionStatus,
  kind: Schema.String,
  purpose: Schema.NullOr(Schema.String),
  payloadJson: Schema.NullOr(Schema.String),
  responseJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ExecutionHistoryInteraction = typeof ExecutionHistoryInteraction.Type;

export const ExecutionHistoryToolCall = Schema.Struct({
  id: Schema.String,
  executionId: Schema.String,
  status: ExecutionHistoryToolCallStatus,
  toolPath: Schema.String,
  namespace: Schema.NullOr(Schema.String),
  argsJson: Schema.NullOr(Schema.String),
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ExecutionHistoryToolCall = typeof ExecutionHistoryToolCall.Type;

export const ExecutionHistoryListItem = Schema.Struct({
  execution: ExecutionHistoryRun,
  pendingInteraction: Schema.NullOr(ExecutionHistoryInteraction),
});
export type ExecutionHistoryListItem = typeof ExecutionHistoryListItem.Type;

export const ExecutionHistoryStatusCount = Schema.Struct({
  status: ExecutionHistoryRunStatus,
  count: Schema.Number,
});
export type ExecutionHistoryStatusCount = typeof ExecutionHistoryStatusCount.Type;

export const ExecutionHistoryTriggerCount = Schema.Struct({
  triggerKind: Schema.NullOr(Schema.String),
  count: Schema.Number,
});
export type ExecutionHistoryTriggerCount = typeof ExecutionHistoryTriggerCount.Type;

export const ExecutionHistoryToolFacet = Schema.Struct({
  toolPath: Schema.String,
  count: Schema.Number,
});
export type ExecutionHistoryToolFacet = typeof ExecutionHistoryToolFacet.Type;

export const ExecutionHistoryChartBucket = Schema.Struct({
  bucketStart: Schema.Number,
  counts: Schema.Record(Schema.String, Schema.Number),
});
export type ExecutionHistoryChartBucket = typeof ExecutionHistoryChartBucket.Type;

export const ExecutionHistoryListMeta = Schema.Struct({
  totalRowCount: Schema.Number,
  filterRowCount: Schema.Number,
  statusCounts: Schema.Array(ExecutionHistoryStatusCount),
  triggerCounts: Schema.Array(ExecutionHistoryTriggerCount),
  toolFacets: Schema.Array(ExecutionHistoryToolFacet),
  interactionCounts: Schema.Struct({
    withInteraction: Schema.Number,
    withoutInteraction: Schema.Number,
  }),
  chartBucketMs: Schema.Number,
  chartData: Schema.Array(ExecutionHistoryChartBucket),
});
export type ExecutionHistoryListMeta = typeof ExecutionHistoryListMeta.Type;

export const ExecutionHistoryListResult = Schema.Struct({
  executions: Schema.Array(ExecutionHistoryListItem),
  nextCursor: Schema.optional(Schema.String),
  meta: Schema.optional(ExecutionHistoryListMeta),
});
export type ExecutionHistoryListResult = typeof ExecutionHistoryListResult.Type;

export const ExecutionHistoryDetail = Schema.Struct({
  execution: ExecutionHistoryRun,
  pendingInteraction: Schema.NullOr(ExecutionHistoryInteraction),
});
export type ExecutionHistoryDetail = typeof ExecutionHistoryDetail.Type;

export interface ExecutionHistoryTimeRange {
  readonly from?: number;
  readonly to?: number;
}

export interface ExecutionHistorySort {
  readonly field: "createdAt" | "durationMs";
  readonly direction: "asc" | "desc";
}

export interface ExecutionHistoryListOptions {
  readonly scopeId: ScopeId | string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly statusFilter?: readonly ExecutionHistoryRunStatus[];
  readonly triggerFilter?: readonly string[];
  readonly toolPathFilter?: readonly string[];
  readonly timeRange?: ExecutionHistoryTimeRange;
  readonly after?: string;
  readonly codeQuery?: string;
  readonly hadInteraction?: boolean;
  readonly sort?: ExecutionHistorySort;
  readonly includeMeta?: boolean;
}

export interface ExecutionHistoryStore {
  readonly handleEvent: (event: ExecutionEvent) => Effect.Effect<void, StorageFailure>;
  readonly list: (
    options: ExecutionHistoryListOptions,
  ) => Effect.Effect<ExecutionHistoryListResult, StorageFailure>;
  readonly get: (
    executionId: ExecutionId | string,
  ) => Effect.Effect<ExecutionHistoryDetail | null, StorageFailure>;
  readonly listToolCalls: (
    executionId: ExecutionId | string,
  ) => Effect.Effect<readonly ExecutionHistoryToolCall[], StorageFailure>;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const CursorPayload = Schema.Struct({
  createdAt: Schema.Number,
  id: Schema.String,
});
const CursorPayloadFromJsonString = Schema.fromJsonString(CursorPayload);
const encodeCursorPayload = Schema.encodeSync(CursorPayloadFromJsonString);
const encodeJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

const toDate = (value: unknown): Date =>
  value instanceof Date ? value : new Date(value as string | number);

const toNumber = (value: unknown): number => Number(value);

const toNumberOrNull = (value: unknown): number | null => (value == null ? null : Number(value));

const toStringOrNull = (value: string | null | undefined): string | null =>
  value == null ? null : value;

const rowToRun = (row: RunRow): ExecutionHistoryRun => ({
  id: row.id,
  scopeId: row.scope_id,
  status: row.status,
  code: row.code,
  resultJson: toStringOrNull(row.result_json),
  errorText: toStringOrNull(row.error_text),
  logsJson: toStringOrNull(row.logs_json),
  startedAt: toNumber(row.started_at),
  completedAt: toNumberOrNull(row.completed_at),
  triggerKind: toStringOrNull(row.trigger_kind),
  triggerMetaJson: toStringOrNull(row.trigger_meta_json),
  toolCallCount: Number(row.tool_call_count ?? 0),
  createdAt: toDate(row.created_at).getTime(),
  updatedAt: toDate(row.updated_at).getTime(),
});

const rowToInteraction = (row: InteractionRow): ExecutionHistoryInteraction => ({
  id: row.id,
  executionId: row.execution_id,
  status: row.status,
  kind: row.kind,
  purpose: toStringOrNull(row.purpose),
  payloadJson: toStringOrNull(row.payload_json),
  responseJson: toStringOrNull(row.response_json),
  errorText: toStringOrNull(row.error_text),
  startedAt: toNumber(row.started_at),
  completedAt: toNumberOrNull(row.completed_at),
  createdAt: toDate(row.created_at).getTime(),
  updatedAt: toDate(row.updated_at).getTime(),
});

const rowToToolCall = (row: ToolCallRow): ExecutionHistoryToolCall => ({
  id: row.id,
  executionId: row.execution_id,
  status: row.status,
  toolPath: row.tool_path,
  namespace: toStringOrNull(row.namespace),
  argsJson: toStringOrNull(row.args_json),
  resultJson: toStringOrNull(row.result_json),
  errorText: toStringOrNull(row.error_text),
  startedAt: toNumber(row.started_at),
  completedAt: toNumberOrNull(row.completed_at),
  durationMs: toNumberOrNull(row.duration_ms),
  createdAt: toDate(row.created_at).getTime(),
  updatedAt: toDate(row.updated_at).getTime(),
});

const encodeCursor = (input: { readonly createdAt: number; readonly id: string }): string =>
  globalThis.btoa(encodeCursorPayload(input));

const decodeCursor = (
  cursor: string,
): Effect.Effect<{ readonly createdAt: number; readonly id: string } | null, never, never> =>
  Effect.try({
    try: () => globalThis.atob(cursor),
    catch: () => null,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CursorPayloadFromJsonString)),
    Effect.catch(() => Effect.succeed(null)),
  );

const jsonString = (value: unknown): Effect.Effect<string | null> =>
  value === undefined
    ? Effect.succeed(null)
    : encodeJsonString(value).pipe(
        Effect.catch(() =>
          Effect.succeed('{"error":"Unable to serialize execution history value"}'),
        ),
      );

const matchesToolGlob = (toolPath: string, pattern: string): boolean => {
  if (pattern === toolPath) return true;
  if (!pattern.endsWith(".*")) return false;
  const prefix = pattern.slice(0, -2);
  return toolPath === prefix || toolPath.startsWith(`${prefix}.`);
};

const pickChartBucketMs = (windowMs: number): number => {
  if (windowMs <= 15 * 60_000) return 30_000;
  if (windowMs <= 60 * 60_000) return 120_000;
  if (windowMs <= 24 * 60 * 60_000) return 30 * 60_000;
  if (windowMs <= 7 * 24 * 60 * 60_000) return 3 * 60 * 60_000;
  return 24 * 60 * 60_000;
};

export const makeExecutionHistoryStore = ({
  adapter,
}: StorageDeps<ExecutionHistorySchema>): ExecutionHistoryStore => {
  const handleEvent: ExecutionHistoryStore["handleEvent"] = (event) =>
    Effect.gen(function* () {
      const timestamp = new Date();
      if (Predicate.isTagged(event, "ExecutionStarted")) {
        yield* adapter.create({
          model: "execution_history_run",
          forceAllowId: true,
          data: {
            id: event.executionId,
            scope_id: event.scopeId,
            status: "running",
            code: event.code,
            result_json: null,
            error_text: null,
            logs_json: null,
            started_at: event.startedAt.getTime(),
            completed_at: null,
            trigger_kind: event.trigger?.kind ?? null,
            trigger_meta_json: yield* jsonString(event.trigger?.metadata),
            tool_call_count: 0,
            created_at: event.startedAt,
            updated_at: timestamp,
          },
        });
        return;
      }

      if (Predicate.isTagged(event, "ExecutionFinished")) {
        yield* adapter.update({
          model: "execution_history_run",
          where: [
            { field: "scope_id", value: event.scopeId },
            { field: "id", value: event.executionId },
          ],
          update: {
            status: event.status,
            result_json: yield* jsonString(event.result),
            error_text: event.error ?? null,
            logs_json: yield* jsonString(event.logs),
            completed_at: event.completedAt.getTime(),
            updated_at: timestamp,
          },
        });
        return;
      }

      if (Predicate.isTagged(event, "ToolCallStarted")) {
        yield* adapter.create({
          model: "execution_history_tool_call",
          forceAllowId: true,
          data: {
            id: event.toolCallId,
            scope_id: event.scopeId,
            execution_id: event.executionId,
            status: "running",
            tool_path: event.path,
            namespace: event.path.split(".")[0] ?? null,
            args_json: yield* jsonString(event.args),
            result_json: null,
            error_text: null,
            started_at: event.startedAt.getTime(),
            completed_at: null,
            duration_ms: null,
            created_at: timestamp,
            updated_at: timestamp,
          },
        });
        yield* adapter.update({
          model: "execution_history_run",
          where: [
            { field: "scope_id", value: event.scopeId },
            { field: "id", value: event.executionId },
          ],
          update: { updated_at: timestamp },
        });
        return;
      }

      if (Predicate.isTagged(event, "ToolCallFinished")) {
        const existing = yield* adapter.findOne({
          model: "execution_history_tool_call",
          where: [
            { field: "scope_id", value: event.scopeId },
            { field: "id", value: event.toolCallId },
          ],
        });
        const startedAt = Number(existing?.started_at ?? event.completedAt.getTime());
        yield* adapter.update({
          model: "execution_history_tool_call",
          where: [
            { field: "scope_id", value: event.scopeId },
            { field: "id", value: event.toolCallId },
          ],
          update: {
            status: event.status,
            result_json: yield* jsonString(event.result),
            error_text: event.error ?? null,
            completed_at: event.completedAt.getTime(),
            duration_ms: Math.max(0, event.completedAt.getTime() - startedAt),
            updated_at: timestamp,
          },
        });
        const calls = yield* adapter.count({
          model: "execution_history_tool_call",
          where: [
            { field: "scope_id", value: event.scopeId },
            { field: "execution_id", value: event.executionId },
          ],
        });
        yield* adapter.update({
          model: "execution_history_run",
          where: [
            { field: "scope_id", value: event.scopeId },
            { field: "id", value: event.executionId },
          ],
          update: { tool_call_count: calls, updated_at: timestamp },
        });
        return;
      }

      if (Predicate.isTagged(event, "InteractionStarted")) {
        const requestKind = Predicate.isTagged(event.context.request, "FormElicitation")
          ? "FormElicitation"
          : "UrlElicitation";
        yield* adapter.create({
          model: "execution_history_interaction",
          forceAllowId: true,
          data: {
            id: event.interactionId,
            scope_id: event.scopeId,
            execution_id: event.executionId,
            status: "pending",
            kind: requestKind,
            purpose: event.context.request.message,
            payload_json: yield* jsonString(event.context),
            response_json: null,
            error_text: null,
            started_at: event.startedAt.getTime(),
            completed_at: null,
            created_at: timestamp,
            updated_at: timestamp,
          },
        });
        return;
      }

      yield* adapter.update({
        model: "execution_history_interaction",
        where: [
          { field: "scope_id", value: event.scopeId },
          { field: "id", value: event.interactionId },
        ],
        update: {
          status: event.status,
          response_json: yield* jsonString(event.response),
          error_text: event.error ?? null,
          completed_at: event.completedAt.getTime(),
          updated_at: timestamp,
        },
      });
    });

  const get: ExecutionHistoryStore["get"] = (executionId) =>
    Effect.gen(function* () {
      const row = yield* adapter.findOne({
        model: "execution_history_run",
        where: [{ field: "id", value: executionId }],
      });
      if (!row) return null;
      const pending = yield* adapter.findMany({
        model: "execution_history_interaction",
        where: [
          { field: "execution_id", value: executionId },
          { field: "status", value: "pending" },
        ],
        sortBy: { field: "started_at", direction: "desc" },
        limit: 1,
      });
      return {
        execution: rowToRun(row),
        pendingInteraction: pending[0] ? rowToInteraction(pending[0]) : null,
      };
    });

  const listToolCalls: ExecutionHistoryStore["listToolCalls"] = (executionId) =>
    adapter
      .findMany({
        model: "execution_history_tool_call",
        where: [{ field: "execution_id", value: executionId }],
        sortBy: { field: "started_at", direction: "asc" },
      })
      .pipe(Effect.map((rows) => rows.map(rowToToolCall)));

  const list: ExecutionHistoryStore["list"] = (rawOptions) =>
    Effect.gen(function* () {
      const options = rawOptions;
      const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      const sort = options.sort ?? { field: "createdAt", direction: "desc" as const };
      const rows = yield* adapter.findMany({
        model: "execution_history_run",
        where: [{ field: "scope_id", value: options.scopeId }],
        sortBy: {
          field: sort.field === "durationMs" ? "completed_at" : "created_at",
          direction: sort.direction,
        },
      });
      const toolCallRows = yield* adapter.findMany({ model: "execution_history_tool_call" });
      const interactionRows = yield* adapter.findMany({ model: "execution_history_interaction" });
      const toolCallsByExecution = new Map<string, ToolCallRow[]>();
      for (const toolCall of toolCallRows) {
        const list = toolCallsByExecution.get(toolCall.execution_id) ?? [];
        list.push(toolCall);
        toolCallsByExecution.set(toolCall.execution_id, list);
      }
      const executionsWithInteractions = new Set(interactionRows.map((row) => row.execution_id));

      const filtered = rows.filter((row) => {
        if (
          options.statusFilter &&
          options.statusFilter.length > 0 &&
          !options.statusFilter.includes(row.status)
        ) {
          return false;
        }
        if (options.triggerFilter && options.triggerFilter.length > 0) {
          const triggerKind = row.trigger_kind ?? null;
          if (
            !options.triggerFilter.some((want) =>
              want === "unknown" ? triggerKind === null : triggerKind === want,
            )
          ) {
            return false;
          }
        }
        if (options.toolPathFilter && options.toolPathFilter.length > 0) {
          const calls = toolCallsByExecution.get(row.id) ?? [];
          if (
            !options.toolPathFilter.some((pattern) =>
              calls.some((call) => matchesToolGlob(call.tool_path, pattern)),
            )
          ) {
            return false;
          }
        }
        const createdAt = toDate(row.created_at).getTime();
        if (options.timeRange?.from !== undefined && createdAt < options.timeRange.from) {
          return false;
        }
        if (options.timeRange?.to !== undefined && createdAt > options.timeRange.to) {
          return false;
        }
        if (options.after !== undefined) {
          const afterMs = Number(options.after);
          if (!Number.isNaN(afterMs) && createdAt <= afterMs) return false;
        }
        if (
          options.codeQuery &&
          !row.code.toLowerCase().includes(options.codeQuery.toLowerCase())
        ) {
          return false;
        }
        if (options.hadInteraction !== undefined) {
          const has = executionsWithInteractions.has(row.id);
          if (options.hadInteraction !== has) return false;
        }
        return true;
      });

      const cursor = options.cursor ? yield* decodeCursor(options.cursor) : null;
      const afterCursor = cursor
        ? filtered.filter((row) => {
            const createdAt = toDate(row.created_at).getTime();
            if (createdAt < cursor.createdAt) return true;
            if (createdAt > cursor.createdAt) return false;
            return row.id < cursor.id;
          })
        : filtered;

      const page = afterCursor.slice(0, limit);
      const nextCursor =
        afterCursor.length > limit && sort.field === "createdAt"
          ? encodeCursor({
              createdAt: toDate(page[page.length - 1]!.created_at).getTime(),
              id: page[page.length - 1]!.id,
            })
          : undefined;
      const pageIds = new Set(page.map((row) => row.id));
      const pendingByExecution = new Map<string, InteractionRow>();
      for (const interaction of interactionRows) {
        if (interaction.status !== "pending") continue;
        if (!pageIds.has(interaction.execution_id)) continue;
        const previous = pendingByExecution.get(interaction.execution_id);
        if (!previous || toNumber(interaction.started_at) > toNumber(previous.started_at)) {
          pendingByExecution.set(interaction.execution_id, interaction);
        }
      }

      const executions = page.map((row) => ({
        execution: rowToRun(row),
        pendingInteraction: pendingByExecution.has(row.id)
          ? rowToInteraction(pendingByExecution.get(row.id)!)
          : null,
      }));

      const buildMeta = (): ExecutionHistoryListMeta => {
        const statusCounts = EXECUTION_HISTORY_RUN_STATUSES.map((status) => ({
          status,
          count: filtered.filter((row) => row.status === status).length,
        }));
        const triggerMap = new Map<string | null, number>();
        for (const row of filtered) {
          const key = row.trigger_kind ?? null;
          triggerMap.set(key, (triggerMap.get(key) ?? 0) + 1);
        }
        const toolMap = new Map<string, number>();
        for (const row of filtered) {
          for (const toolCall of toolCallsByExecution.get(row.id) ?? []) {
            const path = toolCall.tool_path;
            toolMap.set(path, (toolMap.get(path) ?? 0) + 1);
          }
        }
        const withInteraction = filtered.filter((row) =>
          executionsWithInteractions.has(row.id),
        ).length;
        const times = filtered.map((row) => toDate(row.created_at).getTime());
        const now = Date.now();
        const min = times.length > 0 ? Math.min(...times) : now;
        const max = times.length > 0 ? Math.max(...times) : now;
        const chartBucketMs = pickChartBucketMs(Math.max(1, max - min));
        const bucketMap = new Map<number, Record<ExecutionHistoryRunStatus, number>>();
        for (const row of filtered) {
          const bucketStart =
            Math.floor(toDate(row.created_at).getTime() / chartBucketMs) * chartBucketMs;
          const counts = bucketMap.get(bucketStart) ?? { running: 0, completed: 0, failed: 0 };
          counts[row.status] += 1;
          bucketMap.set(bucketStart, counts);
        }
        return {
          totalRowCount: rows.length,
          filterRowCount: filtered.length,
          statusCounts,
          triggerCounts: Array.from(triggerMap.entries()).map(([triggerKind, count]) => ({
            triggerKind,
            count,
          })),
          toolFacets: Array.from(toolMap.entries())
            .map(([toolPath, count]) => ({ toolPath, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20),
          interactionCounts: {
            withInteraction,
            withoutInteraction: filtered.length - withInteraction,
          },
          chartBucketMs,
          chartData: Array.from(bucketMap.entries())
            .map(([bucketStart, counts]) => ({ bucketStart, counts }))
            .sort((a, b) => a.bucketStart - b.bucketStart),
        };
      };

      return {
        executions,
        ...(nextCursor ? { nextCursor } : {}),
        ...(options.includeMeta ? { meta: buildMeta() } : {}),
      };
    });

  return { handleEvent, list, get, listToolCalls };
};

export const makeExecutionHistoryObserver = (
  store: ExecutionHistoryStore,
): ExecutionObserver<StorageFailure> => ({
  handle: store.handleEvent,
});
