import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildMcpRemoteConfigKey,
  mcpDiscoveryRequiresOAuth,
} from "./oauth-detection";

describe("oauth-detection", () => {
  it("builds a stable remote config key with query params", () => {
    expect(buildMcpRemoteConfigKey({
      transport: "auto",
      endpoint: "https://example.com/mcp",
      queryParams: {
        transport: "streamable-http",
        profile: "team",
      },
    })).toBe("https://example.com/mcp?transport=streamable-http&profile=team");
  });

  it("ignores stdio transports", () => {
    expect(buildMcpRemoteConfigKey({
      transport: "stdio",
      endpoint: "https://example.com/mcp",
      queryParams: null,
    })).toBeNull();
  });

  it("recognizes supported OAuth discovery results", () => {
    expect(mcpDiscoveryRequiresOAuth({
      detectedKind: "plugin",
      confidence: "high",
      endpoint: "https://example.com/mcp",
      specUrl: null,
      name: "Example",
      namespace: "example",
      transport: "auto",
      authInference: {
        suggestedKind: "oauth2",
        confidence: "high",
        supported: true,
        reason: "OAuth is required",
        headerName: "Authorization",
        prefix: "Bearer ",
        parameterName: null,
        parameterLocation: null,
        oauthAuthorizationUrl: "https://example.com/oauth/authorize",
        oauthTokenUrl: "https://example.com/oauth/token",
        oauthScopes: [],
      },
      toolCount: null,
      warnings: [],
    })).toBe(true);
  });

  it("ignores non-OAuth or unsupported discovery results", () => {
    expect(mcpDiscoveryRequiresOAuth({
      detectedKind: "plugin",
      confidence: "high",
      endpoint: "https://example.com/mcp",
      specUrl: null,
      name: "Example",
      namespace: "example",
      transport: "auto",
      authInference: {
        suggestedKind: "basic",
        confidence: "medium",
        supported: false,
        reason: "Basic auth challenge",
        headerName: "Authorization",
        prefix: "Basic ",
        parameterName: null,
        parameterLocation: null,
        oauthAuthorizationUrl: null,
        oauthTokenUrl: null,
        oauthScopes: [],
      },
      toolCount: null,
      warnings: [],
    })).toBe(false);
  });
});
