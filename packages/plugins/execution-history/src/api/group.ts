import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { InternalError, ScopeId } from "@executor-js/sdk/core";

import {
  ExecutionHistoryDetail,
  ExecutionHistoryListResult,
  ExecutionHistoryToolCall,
} from "../sdk/store";

const DomainErrors = [InternalError] as const;

const ExecutionParams = {
  scopeId: ScopeId,
  executionId: Schema.String,
};

const ListHistoryParams = {
  scopeId: ScopeId,
};

const ListHistoryQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  trigger: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  from: Schema.optional(Schema.NumberFromString),
  to: Schema.optional(Schema.NumberFromString),
  after: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.String),
  interaction: Schema.optional(Schema.String),
});

export const ExecutionHistoryGroup = HttpApiGroup.make("executionHistory")
  .add(
    HttpApiEndpoint.get("list", "/scopes/:scopeId/execution-history/runs", {
      params: ListHistoryParams,
      query: ListHistoryQuery,
      success: ExecutionHistoryListResult,
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/scopes/:scopeId/execution-history/runs/:executionId", {
      params: ExecutionParams,
      success: Schema.NullOr(ExecutionHistoryDetail),
      error: DomainErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "listToolCalls",
      "/scopes/:scopeId/execution-history/runs/:executionId/tool-calls",
      {
        params: ExecutionParams,
        success: Schema.Struct({ toolCalls: Schema.Array(ExecutionHistoryToolCall) }),
        error: DomainErrors,
      },
    ),
  );
