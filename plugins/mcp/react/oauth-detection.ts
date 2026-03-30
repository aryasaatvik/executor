import type {
  McpDiscoverResult,
} from "@executor/plugin-mcp-shared";

import type {
  McpTransportValue,
} from "./transport";

export const buildMcpRemoteConfigKey = (input: {
  transport: McpTransportValue;
  endpoint: string;
  queryParams: Readonly<Record<string, string>> | null | undefined;
}): string | null => {
  if (input.transport === "stdio") {
    return null;
  }

  const trimmedEndpoint = input.endpoint.trim();
  if (trimmedEndpoint.length === 0) {
    return null;
  }

  const url = new URL(trimmedEndpoint);
  for (const [key, value] of Object.entries(input.queryParams ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
};

export const mcpDiscoveryRequiresOAuth = (
  result: McpDiscoverResult | null | undefined,
): boolean =>
  result?.authInference.supported === true
  && result.authInference.suggestedKind === "oauth2";
