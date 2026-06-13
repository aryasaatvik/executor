import { definePlugin, type ExecutionObserver } from "@executor-js/sdk/core";

import { createExecutionMetricsObserver } from "./observer";

export interface ExecutionMetricsPluginOptions {
  /** Override the observer factory. Defaults to the Effect Metric sink
   *  ({@link createExecutionMetricsObserver}). A host on Cloudflare can pass a
   *  Workers Analytics Engine observer here instead. */
  readonly observer?: () => ExecutionObserver;
}

/**
 * Opt-in execution-metrics sink. Registers an {@link ExecutionObserver} via
 * `runtime.executionObserver` so the engine fans every {@link ExecutionEvent}
 * to it. The base plugin carries NO HTTP surface — import
 * `@executor-js/plugin-execution-metrics/api` for the Prometheus scrape, and
 * never load `@executor-js/api` from here.
 */
export const executionMetricsPlugin = definePlugin((options?: ExecutionMetricsPluginOptions) => ({
  id: "execution-metrics" as const,
  packageName: "@executor-js/plugin-execution-metrics",
  storage: () => ({}),
  runtime: {
    executionObserver: options?.observer ?? createExecutionMetricsObserver,
  },
}));
