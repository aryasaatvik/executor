import { HttpApiBuilder } from "effect/unstable/httpapi";

import { addGroup } from "@executor-js/api";
import { ExecutionMetricsGroup } from "./group";
import { renderPrometheus } from "./prometheus";

// ---------------------------------------------------------------------------
// Composed API — core + execution-metrics group
// ---------------------------------------------------------------------------

const ExecutorApiWithMetrics = addGroup(ExecutionMetricsGroup);

// ---------------------------------------------------------------------------
// Handlers
//
// The scrape reads the global Effect Metric registry directly (no plugin
// extension state), so there is no `extensionService` to require — the handler
// just renders the snapshot. `renderPrometheus` has no error channel, so no
// `capture` translation is needed; the group's `InternalError` covers defects
// the edge middleware captures.
// ---------------------------------------------------------------------------

export const ExecutionMetricsHandlers = HttpApiBuilder.group(
  ExecutorApiWithMetrics,
  "execution-metrics",
  (handlers) => handlers.handle("metrics", () => renderPrometheus),
);
