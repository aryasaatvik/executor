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
import { encryptedSecretsPlugin } from "@executor-js/plugin-encrypted-secrets";

// ---------------------------------------------------------------------------
// Plugin list for the Cloudflare web build. The Vite `executorVitePlugin` reads
// this to assemble `virtual:executor/plugins-client` (the client-side plugin
// bundles the shell renders). It mirrors the runtime list in src/plugins.ts —
// same protocol/provider plugins as self-host. The encrypted-secrets key only
// matters at runtime (server side); a build-time placeholder is fine here since
// the client bundle never holds the key.
// ---------------------------------------------------------------------------

export default defineExecutorConfig({
  plugins: () =>
    [
      // <executor:plugin:openapi>
      openApiHttpPlugin(),
      // </executor:plugin:openapi>
      // <executor:plugin:mcp>
      mcpHttpPlugin({ dangerouslyAllowStdioMCP: false }),
      // </executor:plugin:mcp>
      // <executor:plugin:graphql>
      graphqlHttpPlugin(),
      // </executor:plugin:graphql>
      encryptedSecretsPlugin({ key: process.env.EXECUTOR_SECRET_KEY ?? "build-time-placeholder" }),
    ] as const,
});
