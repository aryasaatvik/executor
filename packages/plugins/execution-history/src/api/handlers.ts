import { Context, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { addGroup, capture } from "@executor-js/api";

import { RunStatus } from "../sdk/collections";
import type { ExecutionHistoryListOptions, ExecutionHistoryStore } from "../sdk/store";
import { ExecutionHistoryGroup, RunsCursorFromString } from "./group";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const isRunStatus = Schema.is(RunStatus);
const decodeCursor = Schema.decodeUnknownOption(RunsCursorFromString);
const encodeCursor = Schema.encodeUnknownOption(RunsCursorFromString);

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `executor.executionHistory` read surface. The host app provides an
// already-wrapped extension via
// `Layer.succeed(ExecutionHistoryExtensionService, executor.executionHistory)`.
// Only the read methods are reached here; `handleEvent` is the runtime writer
// and never crosses the HTTP edge. Handlers see `StorageFailure` in the typed
// channel and `capture` downgrades it to `InternalError({ traceId })`, which
// matches the group's `error: InternalError`.
// ---------------------------------------------------------------------------

export type ExecutionHistoryExtension = Pick<ExecutionHistoryStore, "list" | "get">;

export class ExecutionHistoryExtensionService extends Context.Service<
  ExecutionHistoryExtensionService,
  ExecutionHistoryExtension
>()("ExecutionHistoryExtensionService") {}

// ---------------------------------------------------------------------------
// Composed API — core + executionHistory group
// ---------------------------------------------------------------------------

const ExecutorApiWithExecutionHistory = addGroup(ExecutionHistoryGroup);

// ---------------------------------------------------------------------------
// Query-param helpers
// ---------------------------------------------------------------------------

/** Split a CSV query value into trimmed, non-empty parts. */
const splitCsv = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

/** Interpret a string query flag as a boolean, mirroring core's "true"/"false"
 *  convention. Any other value (including absent) is left undefined. */
const parseBooleanFlag = (value: string | undefined): boolean | undefined => {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
};

// ---------------------------------------------------------------------------
// Handlers
//
// Each handler yields the extension service, maps query/params onto the store's
// options, and returns. Storage failures flow through the typed channel and are
// captured + downgraded to `InternalError({ traceId })` by `capture`.
// ---------------------------------------------------------------------------

export const ExecutionHistoryHandlers = HttpApiBuilder.group(
  ExecutorApiWithExecutionHistory,
  "executionHistory",
  (handlers) =>
    handlers
      .handle("list", ({ query }) =>
        capture(
          Effect.gen(function* () {
            const history = yield* ExecutionHistoryExtensionService;
            // Keep only valid RunStatus literals — an unknown `?status=bogus`
            // must not reach the storage `where` clause.
            const statusFilter = splitCsv(query.status).filter(isRunStatus);
            const triggerFilter = splitCsv(query.trigger);
            const actorFilter = splitCsv(query.actor);
            const timeRange =
              query.from !== undefined || query.to !== undefined
                ? { from: query.from, to: query.to }
                : undefined;
            const cursor =
              query.cursor !== undefined
                ? Option.getOrUndefined(decodeCursor(query.cursor))
                : undefined;
            const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
            const options: ExecutionHistoryListOptions = {
              statusFilter: statusFilter.length > 0 ? statusFilter : undefined,
              triggerFilter: triggerFilter.length > 0 ? triggerFilter : undefined,
              actorFilter: actorFilter.length > 0 ? actorFilter : undefined,
              timeRange,
              hadInteraction: parseBooleanFlag(query.interaction),
              after: query.after,
              sortField: query.sort,
              sortDirection: query.dir,
              limit,
              cursor,
            };
            const result = yield* history.list(options);
            return {
              runs: result.runs,
              nextCursor: result.nextCursor
                ? Option.getOrNull(encodeCursor(result.nextCursor))
                : null,
              meta: result.meta,
            };
          }),
        ),
      )
      .handle("get", ({ params }) =>
        capture(
          Effect.gen(function* () {
            const history = yield* ExecutionHistoryExtensionService;
            // `ExecutionHistoryDetail` already matches `RunDetailResponse` (slim
            // run + flat-merged R2 detail), so it returns directly.
            return yield* history.get(params.executionId);
          }),
        ),
      ),
);
