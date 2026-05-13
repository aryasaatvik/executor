import type { ScopeId } from "@executor-js/sdk";
import * as Atom from "effect/unstable/reactivity/Atom";

import { ExecutionHistoryClient } from "./client";

export interface RunsQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: string;
  readonly trigger?: string;
  readonly tool?: string;
  readonly from?: number;
  readonly to?: number;
  readonly after?: string;
  readonly code?: string;
  readonly sort?: string;
  readonly interaction?: string;
}

export const runsAtom = Atom.family(
  (input: { readonly scopeId: ScopeId; readonly query: RunsQuery }) =>
    ExecutionHistoryClient.query("executionHistory", "list", {
      params: { scopeId: input.scopeId },
      query: input.query,
      timeToLive: "10 seconds",
    }),
);

export const runDetailAtom = Atom.family(
  (input: { readonly scopeId: ScopeId; readonly runId: string }) =>
    ExecutionHistoryClient.query("executionHistory", "get", {
      params: { scopeId: input.scopeId, executionId: input.runId },
      timeToLive: "10 seconds",
    }),
);

export const runToolCallsAtom = Atom.family(
  (input: { readonly scopeId: ScopeId; readonly runId: string }) =>
    ExecutionHistoryClient.query("executionHistory", "listToolCalls", {
      params: { scopeId: input.scopeId, executionId: input.runId },
      timeToLive: "10 seconds",
    }),
);
