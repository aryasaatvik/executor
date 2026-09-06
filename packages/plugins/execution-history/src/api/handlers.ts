import { Context, Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { addGroup, capture } from "@executor-js/api";

import { RunStatus } from "../sdk/collections";
import type { ExecutionHistoryListOptions, ExecutionHistoryStore } from "../sdk/store";
import { ExecutionHistoryGroup } from "./group";

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

export type ExecutionHistoryExtension = Pick<
  ExecutionHistoryStore,
  "list" | "get" | "listToolCalls"
>;

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
            const statusFilter = splitCsv(query.status).filter(Schema.is(RunStatus));
            const triggerFilter = splitCsv(query.trigger);
            const timeRange =
              query.from !== undefined || query.to !== undefined
                ? { from: query.from, to: query.to }
                : undefined;
            const options: ExecutionHistoryListOptions = {
              statusFilter: statusFilter.length > 0 ? statusFilter : undefined,
              triggerFilter: triggerFilter.length > 0 ? triggerFilter : undefined,
              timeRange,
              hadInteraction: parseBooleanFlag(query.interaction),
              limit: query.limit,
              offset: query.offset,
              sort: query.sort,
            };
            const result = yield* history.list(options);
            return { runs: result.runs, total: result.total };
          }),
        ),
      )
      .handle("get", ({ params }) =>
        capture(
          Effect.gen(function* () {
            const history = yield* ExecutionHistoryExtensionService;
            const detail = yield* history.get(params.executionId);
            return detail === null
              ? null
              : {
                  run: detail.run,
                  toolCalls: detail.toolCalls,
                  interactions: detail.interactions,
                };
          }),
        ),
      )
      .handle("listToolCalls", ({ params }) =>
        capture(
          Effect.gen(function* () {
            const history = yield* ExecutionHistoryExtensionService;
            const toolCalls = yield* history.listToolCalls(params.executionId);
            return { toolCalls };
          }),
        ),
      ),
);
