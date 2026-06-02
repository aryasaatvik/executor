import { defineExecutorConfig } from "@executor-js/sdk";
// <executor:plugin:openapi>
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
// </executor:plugin:openapi>
// <executor:plugin:mcp>
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
// </executor:plugin:mcp>
// <executor:plugin:graphql>
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
// </executor:plugin:graphql>
import { keychainPlugin } from "@executor-js/plugin-keychain";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";

// ---------------------------------------------------------------------------
// Single source of truth for the local app's plugin list.
//
// Consumed by both the host runtime (src/executor.ts) and the Vite web build
// (`@executor-js/app/vite` reads this to assemble the client-side plugin
// bundles). Executor owns the storage tables; plugins use host-provided storage
// facades instead of contributing schema.
//
// Local is single-user and trusted, so `dangerouslyAllowStdioMCP: true` lets you
// connect stdio MCP servers, and the OS keychain + on-disk file secrets are the
// secret backends (no at-rest master key to manage). First-party and third-party
// plugins use the same import-and-call flow — add your own here.
// ---------------------------------------------------------------------------

export default defineExecutorConfig({
  plugins: () =>
    [
      // <executor:plugin:openapi>
      openApiHttpPlugin(),
      // </executor:plugin:openapi>
      // <executor:plugin:mcp>
      mcpHttpPlugin({ dangerouslyAllowStdioMCP: true }),
      // </executor:plugin:mcp>
      // <executor:plugin:graphql>
      graphqlHttpPlugin(),
      // </executor:plugin:graphql>
      keychainPlugin(),
      fileSecretsPlugin(),
    ] as const,
});
