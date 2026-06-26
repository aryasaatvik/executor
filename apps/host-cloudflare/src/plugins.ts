import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { googleHttpPlugin } from "@executor-js/plugin-google/api";
import { microsoftHttpPlugin } from "@executor-js/plugin-microsoft/api";
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
import { semanticSearchHttpPlugin } from "@executor-js/plugin-semantic-search/api";
import {
  makeVectorizeStore,
  ToolSearchBackend,
  withCloudflareLimits,
  type VectorizeIndex,
} from "@executor-js/plugin-semantic-search";

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
//
// Semantic search follows the same opt-in-by-binding shape: the plugin is
// always in the tuple (its reindex route keeps the API shape stable), but it is
// inert — the engine keeps its lexical `tools.search` — until BOTH a `vectorize`
// binding and the `GEMINI_API_KEY` secret are present. To enable: create a
// Vectorize index + add the binding in wrangler.jsonc and set the secret.
// ---------------------------------------------------------------------------

export const makeCloudflarePlugins = (
  secretKey: string,
  analytics?: AnalyticsEngineDataset,
  vectorize?: VectorizeIndex,
  geminiApiKey?: string,
  searchNamespace?: string,
) => {
  const store = vectorize ? withCloudflareLimits(makeVectorizeStore(vectorize)) : undefined;
  const semanticSearchBackend =
    store && geminiApiKey
      ? ToolSearchBackend.vector({
          store,
          geminiApiKey,
          namespace: searchNamespace,
        })
      : undefined;
  return [
    openApiHttpPlugin(),
    googleHttpPlugin(),
    microsoftHttpPlugin(),
    mcpHttpPlugin({ dangerouslyAllowStdioMCP: false }),
    graphqlHttpPlugin(),
    encryptedSecretsPlugin({ key: secretKey }),
    executionMetricsPlugin({
      observer: () => (analytics ? createWaeMetricsObserver(analytics) : noopExecutionObserver),
    }),
    serviceTokensPlugin(),
    semanticSearchHttpPlugin({ backend: semanticSearchBackend }),
  ] as const;
};

export type CloudflarePlugins = ReturnType<typeof makeCloudflarePlugins>;
