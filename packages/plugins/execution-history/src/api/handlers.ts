import { Context, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { addGroup, capture } from "@executor-js/api";

import {
  EXECUTION_HISTORY_RUN_STATUSES,
  type ExecutionHistoryPluginExtension,
  type ExecutionHistoryRunStatus,
  type ExecutionHistorySort,
} from "../sdk";
import { ExecutionHistoryGroup } from "./group";

export class ExecutionHistoryExtensionService extends Context.Service<
  ExecutionHistoryExtensionService,
  ExecutionHistoryPluginExtension
>()("ExecutionHistoryExtensionService") {}

const ExecutorApiWithExecutionHistory = addGroup(ExecutionHistoryGroup);

const STATUS_SET = new Set<string>(EXECUTION_HISTORY_RUN_STATUSES);
const SORT_FIELDS = new Set(["createdAt", "durationMs"] as const);
const SORT_DIRECTIONS = new Set(["asc", "desc"] as const);

const splitCsv = (value: string | undefined): string[] =>
  value
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : [];

const parseSortParam = (raw: string | undefined): ExecutionHistorySort | undefined => {
  if (!raw) return undefined;
  const [field, direction] = raw.split(",").map((part) => part.trim());
  if (!field || !direction) return undefined;
  if (!SORT_FIELDS.has(field as ExecutionHistorySort["field"])) return undefined;
  if (!SORT_DIRECTIONS.has(direction as ExecutionHistorySort["direction"])) return undefined;
  return {
    field: field as ExecutionHistorySort["field"],
    direction: direction as ExecutionHistorySort["direction"],
  };
};

const parseInteractionParam = (raw: string | undefined): boolean | undefined => {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
};

export const ExecutionHistoryHandlers = HttpApiBuilder.group(
  ExecutorApiWithExecutionHistory,
  "executionHistory",
  (handlers) =>
    handlers
      .handle("list", ({ params, query }) =>
        capture(
          Effect.gen(function* () {
            const history = yield* ExecutionHistoryExtensionService;
            const statuses = splitCsv(query.status).filter(
              (status): status is ExecutionHistoryRunStatus => STATUS_SET.has(status),
            );
            const triggers = splitCsv(query.trigger);
            const tools = splitCsv(query.tool);
            return yield* history.list({
              scopeId: params.scopeId,
              limit: query.limit,
              cursor: query.cursor,
              statusFilter: statuses.length > 0 ? statuses : undefined,
              triggerFilter: triggers.length > 0 ? triggers : undefined,
              toolPathFilter: tools.length > 0 ? tools : undefined,
              timeRange:
                query.from !== undefined || query.to !== undefined
                  ? { from: query.from, to: query.to }
                  : undefined,
              after: query.after,
              codeQuery: query.code,
              sort: parseSortParam(query.sort),
              hadInteraction: parseInteractionParam(query.interaction),
              includeMeta: query.cursor === undefined && query.after === undefined,
            });
          }),
        ),
      )
      .handle("get", ({ params }) =>
        capture(
          Effect.gen(function* () {
            const history = yield* ExecutionHistoryExtensionService;
            return yield* history.get(params.executionId);
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
