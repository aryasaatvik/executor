import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Predicate } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { createAwsIamTokenManager, isManagedAwsMcpEndpoint, parseAwsIamInput } from "./aws-iam";
import { mcpPlugin } from "./plugin";
import { mcpPresets } from "./presets";
import { makeEchoMcpServer, serveMcpServer } from "../testing";

const values = {
  access_key_id: "AKIABOOTSTRAP",
  secret_access_key: "bootstrap-secret",
  role_arn: "arn:aws:iam::123456789012:role/ExecutorAwsMcp",
  external_id: "executor-test",
};

const endpoint = "https://aws-mcp.us-east-1.api.aws/mcp";

const requestBody = (request: HttpClientRequest.HttpClientRequest): string => {
  if (!Predicate.isTagged(request.body, "Uint8Array")) return "";
  return new TextDecoder().decode(request.body.body);
};

const assumeRoleXml = `
<AssumeRoleResponse>
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>ASIATEMPORARY</AccessKeyId>
      <SecretAccessKey>temporary-secret</SecretAccessKey>
      <SessionToken>temporary-session</SessionToken>
      <Expiration>2099-01-01T00:00:00Z</Expiration>
    </Credentials>
  </AssumeRoleResult>
</AssumeRoleResponse>`;

const identityXml = `
<GetCallerIdentityResponse>
  <GetCallerIdentityResult>
    <Account>123456789012</Account>
    <Arn>arn:aws:sts::123456789012:assumed-role/ExecutorAwsMcp/executor-aws-mcp</Arn>
  </GetCallerIdentityResult>
</GetCallerIdentityResponse>`;

const makeAwsClient = (
  seen: HttpClientRequest.HttpClientRequest[],
  options?: { readonly expiresIn?: number; readonly nextToken?: () => string },
) =>
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    seen.push(request);
    const body = requestBody(request);
    if (body.includes("Action=AssumeRole")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(assumeRoleXml, { status: 200 })),
      );
    }
    if (body.includes("Action=GetCallerIdentity")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(identityXml, { status: 200 })),
      );
    }
    if (request.url.includes("oauth.signin.aws")) {
      const accessToken = options?.nextToken?.() ?? "aws-mcp-bearer";
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            `{"access_token":"${accessToken}","expires_in":${options?.expiresIn ?? 3600},"token_type":"Bearer"}`,
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 })),
    );
  });

const makeAwsLayer = (seen: HttpClientRequest.HttpClientRequest[]) =>
  Layer.succeed(HttpClient.HttpClient)(makeAwsClient(seen));

const makeAwsForwardingLayer = (
  seen: HttpClientRequest.HttpClientRequest[],
  mcpEndpoint: string,
  options?: { readonly expiresIn?: number; readonly nextToken?: () => string },
) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const network = yield* HttpClient.HttpClient;
      const aws = makeAwsClient(seen, options);
      return HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
        if (request.url.startsWith("https://aws-mcp.us-east-1.api.aws/mcp")) {
          return network.execute(HttpClientRequest.setUrl(request, mcpEndpoint));
        }
        return request.url.includes("amazonaws.com") || request.url.includes("oauth.signin.aws")
          ? aws.execute(request)
          : network.execute(request);
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

describe("AWS IAM MCP token manager", () => {
  it("ships AWS MCP as an IAM-authenticated managed preset", () => {
    expect(mcpPresets.find((preset) => preset.id === "aws-mcp")).toMatchObject({
      endpoint: "https://aws-mcp.us-east-1.api.aws/mcp",
      authenticationTemplate: [{ kind: "aws_iam" }],
    });
  });

  it("only permits exact managed AWS MCP endpoints", () => {
    expect(isManagedAwsMcpEndpoint("https://aws-mcp.us-east-1.api.aws/mcp")).toBe(true);
    expect(isManagedAwsMcpEndpoint("https://aws-mcp.eu-central-1.api.aws/mcp")).toBe(true);
    expect(isManagedAwsMcpEndpoint("https://attacker.example/mcp")).toBe(false);
    expect(isManagedAwsMcpEndpoint("https://aws-mcp.us-east-1.api.aws:444/mcp")).toBe(false);
    expect(isManagedAwsMcpEndpoint("https://aws-mcp.us-east-1.api.aws/mcp?redirect=attacker")).toBe(
      false,
    );
  });

  it.effect("assumes the configured role, verifies identity, and mints a cached bearer", () =>
    Effect.gen(function* () {
      const seen: HttpClientRequest.HttpClientRequest[] = [];
      const layer = makeAwsLayer(seen);
      const manager = createAwsIamTokenManager();

      const first = yield* manager
        .resolve("org:aws:production", endpoint, values)
        .pipe(Effect.provide(layer));
      const second = yield* manager
        .resolve("org:aws:production", endpoint, values)
        .pipe(Effect.provide(layer));

      expect(first).toMatchObject({
        accessToken: "aws-mcp-bearer",
        accountId: "123456789012",
        arn: "arn:aws:sts::123456789012:assumed-role/ExecutorAwsMcp/executor-aws-mcp",
      });
      expect(second).toEqual(first);
      expect(seen).toHaveLength(3);

      const [assume, identity, token] = seen;
      expect(requestBody(assume!).includes("RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012")).toBe(true);
      expect(assume!.headers.authorization).toContain("Credential=AKIABOOTSTRAP/");
      expect(identity!.headers.authorization).toContain("Credential=ASIATEMPORARY/");
      expect(token!.headers.authorization).toContain("Credential=ASIATEMPORARY/");
      expect(token!.headers["x-amz-security-token"]).toBe("temporary-session");
      expect(requestBody(token!)).toContain('"resource":"aws-mcp.amazonaws.com"');
    }),
  );

  it.effect("deduplicates concurrent token mints for one Executor connection", () =>
    Effect.gen(function* () {
      const seen: HttpClientRequest.HttpClientRequest[] = [];
      const layer = makeAwsLayer(seen);
      const manager = createAwsIamTokenManager();
      const [left, right] = yield* Effect.all(
        [
          manager.resolve("org:aws:shared", endpoint, values),
          manager.resolve("org:aws:shared", endpoint, values),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(layer));
      expect(left.accessToken).toBe("aws-mcp-bearer");
      expect(right).toEqual(left);
      expect(seen).toHaveLength(3);
    }),
  );

  it.effect("rejects a role ARN that cannot establish the expected account", () =>
    Effect.gen(function* () {
      const error = yield* parseAwsIamInput({
        ...values,
        role_arn: "not-an-arn",
      }).pipe(Effect.flip);
      expect(error.stage).toBe("credentials");
      expect(error).toMatchObject({ message: expect.stringContaining("Role ARN") });
    }),
  );

  it.effect("uses the AWS bearer through native discovery, execution, and health", () =>
    Effect.gen(function* () {
      const seen: HttpClientRequest.HttpClientRequest[] = [];
      let tokenGeneration = 0;
      const server = yield* serveMcpServer(
        () =>
          makeEchoMcpServer({
            name: "aws-mcp-test",
            toolName: "aws_docs",
            toolDescription: "Search AWS documentation",
            inputName: "value",
            text: (value) => `AWS:${value}`,
          }),
        {
          path: "/mcp",
          auth: {
            validateAuthorization: (authorization) =>
              Effect.succeed(authorization?.startsWith("Bearer aws-mcp-bearer-") === true),
          },
        },
      );
      const executor = yield* createExecutor({
        ...makeTestConfig({
          plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const,
        }),
        httpClientLayer: makeAwsForwardingLayer(seen, server.endpoint, {
          // Shorter than the refresh skew: each operation rotates the bearer,
          // proving the connection pool cannot retain an older AWS session.
          expiresIn: 1,
          nextToken: () => `aws-mcp-bearer-${++tokenGeneration}`,
        }),
      });
      const integration = IntegrationSlug.make("aws_mcp_test");
      const connection = ConnectionName.make("chosenaccount");
      yield* executor.mcp.addServer({
        name: "AWS MCP Test",
        slug: String(integration),
        endpoint: "https://aws-mcp.us-east-1.api.aws/mcp",
        authenticationTemplate: [{ kind: "aws_iam" }],
      });
      yield* executor.connections.create({
        owner: "org",
        name: connection,
        integration,
        template: AuthTemplateSlug.make("aws_iam"),
        values,
      });

      expect(seen).toHaveLength(3);
      expect((yield* server.requests).length).toBeGreaterThan(0);
      const discovered = yield* executor.tools.list();
      expect(discovered.map((tool) => String(tool.address))).toContain(
        "tools.aws_mcp_test.org.chosenaccount.aws_docs",
      );

      const result = yield* executor.execute(
        ToolAddress.make("tools.aws_mcp_test.org.chosenaccount.aws_docs"),
        { value: "S3" },
      );
      expect(result).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "AWS:S3" }] },
      });
      const health = yield* executor.connections.checkHealth({
        owner: "org",
        integration,
        name: connection,
      });
      expect(health).toMatchObject({
        status: "healthy",
        identity:
          "123456789012 · arn:aws:sts::123456789012:assumed-role/ExecutorAwsMcp/executor-aws-mcp",
      });
      const requests = yield* server.requests;
      const authorizations = new Set(requests.map((request) => request.authorization));
      expect(authorizations.has("Bearer aws-mcp-bearer-1")).toBe(true);
      expect(authorizations.has("Bearer aws-mcp-bearer-2")).toBe(true);
      expect(authorizations.has("Bearer aws-mcp-bearer-4")).toBe(true);
      expect(seen).toHaveLength(12);
    }),
  );
});
