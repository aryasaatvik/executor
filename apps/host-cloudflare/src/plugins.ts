import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { encryptedSecretsPlugin } from "@executor-js/plugin-encrypted-secrets";
import { executionMetricsPlugin } from "@executor-js/plugin-execution-metrics";
import {
  createWaeMetricsObserver,
  type AnalyticsEngineDataset,
} from "@executor-js/plugin-execution-metrics/cloudflare";
import { noopExecutionObserver } from "@executor-js/sdk";
import { serviceTokensPlugin } from "@executor-js/plugin-service-tokens/server";

// ---------------------------------------------------------------------------
// The Cloudflare host's plugin list — the same protocol/provider plugins as
// self-host (no WorkOS Vault). Built as a factory because the encrypted-secrets
// master key arrives via `env` at request time (no process.env on a Worker), so
// the plugin set is constructed per app-build with the resolved key. The tuple
// SHAPE (which drives the API + table set) is independent of the key value.
//
// `dangerouslyAllowStdioMCP` is false: a multi-user instance must not let a user
// spawn arbitrary stdio MCP processes.
//
// Execution metrics ship to Workers Analytics Engine — opt-in via the wrangler
// `ANALYTICS` binding. The plugin is always in the tuple (it has no tables/API,
// so the shape is stable), but its observer is a no-op until `env.ANALYTICS` is
// bound. Effect's Metric registry is per-isolate (meaningless on a Worker
// fleet), so the local Prometheus scrape is deliberately NOT mounted here; WAE
// is the durable sink. To enable: uncomment `analytics_engine_datasets` in
// wrangler.jsonc.
// ---------------------------------------------------------------------------

export const makeCloudflarePlugins = (secretKey: string, analytics?: AnalyticsEngineDataset) =>
  [
    openApiHttpPlugin(),
    mcpHttpPlugin({ dangerouslyAllowStdioMCP: false }),
    graphqlHttpPlugin(),
    encryptedSecretsPlugin({ key: secretKey }),
    executionMetricsPlugin({
      observer: () => (analytics ? createWaeMetricsObserver(analytics) : noopExecutionObserver),
    }),
    serviceTokensPlugin(),
  ] as const;

export type CloudflarePlugins = ReturnType<typeof makeCloudflarePlugins>;
