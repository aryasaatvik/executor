import * as Atom from "effect/unstable/reactivity/Atom";

import { ExecutionHistoryClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms for the execution-history read model.
//
// The list atom is parameterized by the wire query shape of the `list`
// endpoint (status/trigger CSV strings, numeric from/to/after/limit, the
// "true"/"false" interaction flag, sort field + direction, and an opaque
// keyset cursor). Detail + tool-call atoms key off the execution id. Each atom
// is `Atom.family`-keyed so a distinct filter/page/run gets its own cached
// result — matching the graphql plugin's per-input atom pattern.
// ---------------------------------------------------------------------------

export interface RunsQuery {
  readonly status?: string;
  readonly trigger?: string;
  readonly actor?: string;
  readonly from?: number;
  readonly to?: number;
  readonly interaction?: string;
  readonly after?: number;
  readonly sort?: "startedAt" | "durationMs";
  readonly dir?: "asc" | "desc";
  readonly limit?: number;
  readonly cursor?: string;
}

export const runsAtom = Atom.family((query: RunsQuery) =>
  ExecutionHistoryClient.query("executionHistory", "list", {
    query,
    timeToLive: "10 seconds",
  }),
);

export const runDetailAtom = Atom.family((executionId: string) =>
  ExecutionHistoryClient.query("executionHistory", "get", {
    params: { executionId },
    timeToLive: "10 seconds",
  }),
);

export const runToolCallsAtom = Atom.family((executionId: string) =>
  ExecutionHistoryClient.query("executionHistory", "listToolCalls", {
    params: { executionId },
    timeToLive: "10 seconds",
  }),
);
