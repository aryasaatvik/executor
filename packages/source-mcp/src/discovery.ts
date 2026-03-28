import {
  defaultNameFromEndpoint,
  hasAuthorizationHeader,
  namespaceFromSourceName,
  noneAuthInference,
  supportedAuthInference,
  type SourceDiscoveryProbeInput,
  type SourceDiscoveryResult,
} from "@executor/source-core";
import { startMcpOAuthAuthorization } from "@executor/auth-mcp-oauth";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";

import { createSdkMcpConnector } from "./connection";
import { discoverMcpToolsFromConnector } from "./tools";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const detectMcpSource = (
  input: SourceDiscoveryProbeInput,
): Effect.Effect<SourceDiscoveryResult, Error, never> =>
  Effect.gen(function* () {
    const connector = createSdkMcpConnector({
      endpoint: input.normalizedUrl,
      headers: input.headers,
      transport: "auto",
    });

    const discovered = yield* Effect.either(
      discoverMcpToolsFromConnector({
        connect: connector,
        sourceKey: "discovery",
        namespace: namespaceFromSourceName(
          defaultNameFromEndpoint(input.normalizedUrl),
        ),
      }),
    );

    if (Either.isRight(discovered)) {
      const name = defaultNameFromEndpoint(input.normalizedUrl);
      return {
        detectedKind: "mcp",
        confidence: "high",
        endpoint: input.normalizedUrl,
        specUrl: null,
        name,
        namespace: namespaceFromSourceName(name),
        transport: "auto",
        authInference: noneAuthInference(
          "MCP tool discovery succeeded without an advertised auth requirement",
          "medium",
        ),
        toolCount: discovered.right.manifest.tools.length,
        warnings: [],
      } satisfies SourceDiscoveryResult;
    }

    if (hasAuthorizationHeader(input.headers)) {
      return yield* Effect.fail(toError(discovered.left));
    }

    const oauthProbe = yield* Effect.either(
      startMcpOAuthAuthorization({
        endpoint: input.normalizedUrl,
        redirectUrl: "http://127.0.0.1/executor/discovery/oauth/callback",
        state: "source-discovery",
      }),
    );

    if (Either.isRight(oauthProbe)) {
      const name = defaultNameFromEndpoint(input.normalizedUrl);
      return {
        detectedKind: "mcp",
        confidence: "high",
        endpoint: input.normalizedUrl,
        specUrl: null,
        name,
        namespace: namespaceFromSourceName(name),
        transport: "auto",
        authInference: supportedAuthInference("oauth2", {
          confidence: "high",
          reason: "MCP endpoint advertised OAuth during discovery",
          headerName: "Authorization",
          prefix: "Bearer ",
          parameterName: null,
          parameterLocation: null,
          oauthAuthorizationUrl: oauthProbe.right.authorizationUrl,
          oauthTokenUrl: oauthProbe.right.authorizationServerUrl,
          oauthScopes: [],
        }),
        toolCount: null,
        warnings: ["OAuth is required before MCP tools can be listed."],
      } satisfies SourceDiscoveryResult;
    }

    return yield* Effect.fail(
      oauthProbe.left instanceof Error
        ? oauthProbe.left
        : toError(discovered.left),
    );
  });
