import { definePlugin } from "@executor-js/sdk/core";

import { executionMetricsPlugin, type ExecutionMetricsPluginOptions } from "../sdk/plugin";
import { ExecutionMetricsGroup } from "./group";
import { ExecutionMetricsHandlers } from "./handlers";

export { ExecutionMetricsGroup } from "./group";
export { ExecutionMetricsHandlers } from "./handlers";
export { renderPrometheus } from "./prometheus";

// HTTP-augmented variant of `executionMetricsPlugin`. The returned plugin
// carries the HTTP `routes` and `handlers` so a host can mount the Prometheus
// scrape (`GET /execution-metrics/metrics`). The scrape reads the global Effect
// Metric registry, so there is no plugin extension state and no
// `extensionService`. Hosts that compose an `HttpApi` import this; SDK-only
// consumers stay on `@executor-js/plugin-execution-metrics` and never load
// `@executor-js/api`.
export const executionMetricsHttpPlugin = definePlugin(
  (options?: ExecutionMetricsPluginOptions) => ({
    ...executionMetricsPlugin(options),
    routes: () => ExecutionMetricsGroup,
    handlers: () => ExecutionMetricsHandlers,
  }),
);
