import { randomUUID } from "node:crypto";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "@effect/vitest";
import { assertInstanceOf, assertTrue } from "@effect/vitest/utils";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import { z } from "zod/v4";

import type {
  ToolDefinition,
  ToolInput,
  ToolMap,
  ToolPath,
} from "@executor/codemode-core";

import { createSdkMcpConnector } from "./connection";
import { detectMcpSource } from "./discovery";
import {
  McpToolsError,
  type McpClientLike,
  discoverMcpToolsFromConnector,
  extractMcpToolManifestFromListToolsResult,
} from "./tools";

const resolveToolDefinition = (value: ToolInput): ToolDefinition =>
  typeof value === "object" && value !== null && "tool" in value
    ? value
    : { tool: value };

const resolveToolExecutor = (
  tools: ToolMap,
  path: string,
): ((args: unknown) => Promise<unknown>) => {
  const candidate = tools[path];
  if (!candidate) {
    throw new Error(`Missing tool path: ${path}`);
  }

  const resolved = resolveToolDefinition(candidate);
  if (!resolved.tool.execute) {
    throw new Error(`Tool has no execute function: ${path}`);
  }

  return (args: unknown) => Promise.resolve(resolved.tool.execute?.(args));
};

type RealMcpServer = {
  endpoint: string;
  seenValues: string[];
  close: () => Promise<void>;
};

type OAuthProtectedMcpServer = {
  endpoint: string;
  close: () => Promise<void>;
};

const makeRealMcpServer = Effect.acquireRelease(
  Effect.promise<RealMcpServer>(
    () =>
      new Promise<RealMcpServer>((resolve, reject) => {
        const seenValues: string[] = [];

        const createServerForRequest = () => {
          const mcp = new McpServer(
            {
              name: "codemode-mcp-test-server",
              version: "1.0.0",
            },
            {
              capabilities: {
                tools: {},
              },
            },
          );

          mcp.registerTool(
            "echo",
            {
              description: "Echoes the input value",
              inputSchema: {
                value: z.string(),
              },
            },
            async ({ value }: { value: string }) => {
              seenValues.push(value);
              return {
                content: [{ type: "text", text: `echo:${value}` }],
              };
            },
          );

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });

          return { mcp, transport };
        };

        const app = createMcpExpressApp({ host: "127.0.0.1" });

        const handle = async (req: any, res: any, parsedBody?: unknown) => {
          const { mcp, transport } = createServerForRequest();
          try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res, parsedBody);
          } finally {
            await transport.close().catch(() => undefined);
            await mcp.close().catch(() => undefined);
          }
        };

        app.post("/mcp", async (req: any, res: any) => {
          await handle(req, res, req.body);
        });

        app.get("/mcp", async (req: any, res: any) => {
          await handle(req, res);
        });

        app.delete("/mcp", async (req: any, res: any) => {
          await handle(req, res, req.body);
        });

        const listener = app.listen(0, "127.0.0.1", () => {
          const address = listener.address();
          if (!address || typeof address === "string") {
            reject(new Error("failed to resolve MCP test server address"));
            return;
          }

          resolve({
            endpoint: `http://127.0.0.1:${address.port}/mcp`,
            seenValues,
            close: async () => {
              await new Promise<void>((closeResolve, closeReject) => {
                listener.close((error: Error | undefined) => {
                  if (error) {
                    closeReject(error);
                    return;
                  }
                  closeResolve();
                });
              });
            },
          });
        });

        listener.once("error", reject);
      }),
  ),
  (server: RealMcpServer) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(Effect.orDie),
);

const makeAuthenticatedMcpServer = (expectedAuthorization: string) =>
  Effect.acquireRelease(
    Effect.promise<RealMcpServer>(
      () =>
        new Promise<RealMcpServer>((resolve, reject) => {
          const seenValues: string[] = [];

          const createServerForRequest = () => {
            const mcp = new McpServer(
              {
                name: "codemode-mcp-auth-test-server",
                version: "1.0.0",
              },
              {
                capabilities: {
                  tools: {},
                },
              },
            );

            mcp.registerTool(
              "echo",
              {
                description: "Echoes the input value after auth succeeds",
                inputSchema: {
                  value: z.string(),
                },
              },
              async ({ value }: { value: string }) => {
                seenValues.push(value);
                return {
                  content: [{ type: "text", text: `echo:${value}` }],
                };
              },
            );

            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
            });

            return { mcp, transport };
          };

          const app = createMcpExpressApp({ host: "127.0.0.1" });

          const handle = async (req: any, res: any, parsedBody?: unknown) => {
            if (req.headers.authorization !== expectedAuthorization) {
              res.status(401).json({
                jsonrpc: "2.0",
                error: {
                  code: -32001,
                  message: "Unauthorized",
                },
                id: null,
              });
              return;
            }

            const { mcp, transport } = createServerForRequest();
            try {
              await mcp.connect(transport);
              await transport.handleRequest(req, res, parsedBody);
            } finally {
              await transport.close().catch(() => undefined);
              await mcp.close().catch(() => undefined);
            }
          };

          app.post("/mcp", async (req: any, res: any) => {
            await handle(req, res, req.body);
          });

          app.get("/mcp", async (req: any, res: any) => {
            await handle(req, res);
          });

          app.delete("/mcp", async (req: any, res: any) => {
            await handle(req, res, req.body);
          });

          const listener = app.listen(0, "127.0.0.1", () => {
            const address = listener.address();
            if (!address || typeof address === "string") {
              reject(new Error("failed to resolve authenticated MCP test server address"));
              return;
            }

            resolve({
              endpoint: `http://127.0.0.1:${address.port}/mcp`,
              seenValues,
              close: async () => {
                await new Promise<void>((closeResolve, closeReject) => {
                  listener.close((error: Error | undefined) => {
                    if (error) {
                      closeReject(error);
                      return;
                    }
                    closeResolve();
                  });
                });
              },
            });
          });

          listener.once("error", reject);
        }),
    ),
    (server: RealMcpServer) =>
      Effect.tryPromise({
        try: () => server.close(),
        catch: (error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.orDie),
  );

const makeOAuthProtectedMcpServer = Effect.acquireRelease(
  Effect.promise<OAuthProtectedMcpServer>(
    () =>
      new Promise<OAuthProtectedMcpServer>((resolve, reject) => {
        const app = createMcpExpressApp({ host: "127.0.0.1" });
        const listener = app.listen(0, "127.0.0.1", () => {
          const address = listener.address();
          if (!address || typeof address === "string") {
            reject(new Error("failed to resolve OAuth-protected MCP test server address"));
            return;
          }

          const baseUrl = `http://127.0.0.1:${address.port}`;
          const endpoint = `${baseUrl}/mcp`;
          const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;

          app.post("/mcp", (_req: any, res: any) => {
            res.status(401).set(
              "WWW-Authenticate",
              `Bearer resource_metadata="${resourceMetadataUrl}"`,
            ).json({
              error: "unauthorized",
            });
          });

          app.get("/mcp", (_req: any, res: any) => {
            res.status(401).set(
              "WWW-Authenticate",
              `Bearer resource_metadata="${resourceMetadataUrl}"`,
            ).json({
              error: "unauthorized",
            });
          });

          app.get("/.well-known/oauth-protected-resource/mcp", (_req: any, res: any) => {
            res.status(200).json({
              resource: endpoint,
              authorization_servers: [baseUrl],
              scopes_supported: ["openid", "offline_access"],
              bearer_methods_supported: ["header"],
            });
          });

          app.get("/.well-known/oauth-authorization-server", (_req: any, res: any) => {
            res.status(200).json({
              issuer: baseUrl,
              authorization_endpoint: `${baseUrl}/authorize`,
              token_endpoint: `${baseUrl}/token`,
              registration_endpoint: `${baseUrl}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["none"],
            });
          });

          app.post("/register", (req: any, res: any) => {
            res.status(201).json({
              ...req.body,
              client_id: `client_${randomUUID()}`,
              client_id_issued_at: Math.floor(Date.now() / 1000),
            });
          });

          resolve({
            endpoint,
            close: async () => {
              await new Promise<void>((closeResolve, closeReject) => {
                listener.close((error: Error | undefined) => {
                  if (error) {
                    closeReject(error);
                    return;
                  }
                  closeResolve();
                });
              });
            },
          });
        });

        listener.once("error", reject);
      }),
  ),
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(Effect.orDie),
);

const makeThrowingAuthProvider = (): OAuthClientProvider => ({
  redirectUrl: "http://127.0.0.1/callback",
  clientMetadata: {
    redirect_uris: ["http://127.0.0.1/callback"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_name: "codemode-mcp-test",
  },
  clientInformation: () => undefined,
  saveClientInformation: () => Promise.resolve(),
  tokens: () => {
    throw new Error("authProvider.tokens should not be called");
  },
  saveTokens: () => Promise.resolve(),
  redirectToAuthorization: () => {
    throw new Error("redirectToAuthorization should not be called");
  },
  saveCodeVerifier: () => undefined,
  codeVerifier: () => {
    throw new Error("codeVerifier should not be called");
  },
});


describe("codemode-mcp", () => {
  it.effect("extracts stable unique MCP tool ids", () =>
    Effect.gen(function* () {
      const manifest = extractMcpToolManifestFromListToolsResult({
        tools: [
          { name: "Read File", description: "Reads a file" },
          { name: "Read.File", description: "Also reads a file" },
          { name: "List Users", description: null },
        ],
      });

      expect(manifest.version).toBe(2);
      expect(manifest.tools.map((tool) => tool.toolId)).toEqual([
        "read_file",
        "read_file_2",
        "list_users",
      ]);
      expect(manifest.tools[0]?.toolName).toBe("Read File");
    }),
  );

  it.effect("preserves MCP annotations and server introspection metadata", () =>
    Effect.gen(function* () {
      const manifest = extractMcpToolManifestFromListToolsResult(
        {
          tools: [
            {
              name: "Read File",
              title: "Read File",
              description: "Read a file from memory",
              inputSchema: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                  },
                },
                required: ["path"],
              },
              outputSchema: {
                type: "object",
                properties: {
                  content: {
                    type: "string",
                  },
                },
                required: ["content"],
              },
              annotations: {
                title: "Read File (Annotated)",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
              execution: {
                taskSupport: "optional",
              },
              icons: [{
                src: "https://example.test/icon.png",
                mimeType: "image/png",
              }],
              _meta: {
                category: "filesystem",
              },
            },
          ],
          nextCursor: "cursor_2",
          _meta: {
            page: 1,
          },
        },
        {
          serverInfo: {
            name: "mcp-test-server",
            version: "1.2.3",
            title: "Executor MCP",
            description: "Test server",
            websiteUrl: "https://example.test/mcp",
          },
          serverCapabilities: {
            tools: {
              listChanged: true,
            },
            tasks: {
              list: {},
              requests: {
                tools: {
                  call: {},
                },
              },
            },
          },
          instructions: "Use the tools carefully.",
        },
      );

      expect(manifest.version).toBe(2);
      expect(manifest.tools[0]).toMatchObject({
        toolId: "read_file",
        toolName: "Read File",
        title: "Read File",
        displayTitle: "Read File",
        annotations: {
          title: "Read File (Annotated)",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        execution: {
          taskSupport: "optional",
        },
        meta: {
          category: "filesystem",
        },
      });
      expect(manifest.tools[0]?.rawTool).toMatchObject({
        name: "Read File",
      });
      expect(manifest.server).toMatchObject({
        info: {
          name: "mcp-test-server",
          version: "1.2.3",
          title: "Executor MCP",
        },
        capabilities: {
          tools: {
            listChanged: true,
          },
          tasks: {
            list: true,
            cancel: false,
            toolCall: true,
          },
        },
        instructions: "Use the tools carefully.",
      });
      expect(manifest.listTools).toMatchObject({
        nextCursor: "cursor_2",
        meta: {
          page: 1,
        },
      });
    }),
  );

  it.effect("discovers MCP tools and invokes via connector", () =>
    Effect.gen(function* () {
      let connectCalls = 0;
      let closeCalls = 0;
      const callInputs: Array<{ name: string; arguments: Record<string, unknown> }> = [];

      const connect = Effect.sync(() => {
        connectCalls += 1;

        return {
          client: {
            listTools: async () => ({
              tools: [
                {
                  name: "Echo",
                  title: "Echo",
                  description: "Echo payload",
                  inputSchema: {
                    type: "object",
                    properties: {
                      value: { type: "string" },
                    },
                  },
                  annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                  },
                  _meta: {
                    category: "demo",
                  },
                },
              ],
            }),
            callTool: async (input: { name: string; arguments?: Record<string, unknown> }) => {
              callInputs.push({
                name: input.name,
                arguments: input.arguments ?? {},
              });

              return {
                content: [{ type: "text", text: "ok" }],
                isError: false,
              };
            },
            getServerVersion: () => ({
              name: "mcp-demo-server",
              version: "1.0.0",
              title: "Demo Server",
            }),
            getServerCapabilities: () => ({
              tools: {
                listChanged: true,
              },
            }),
          },
          close: async () => {
            closeCalls += 1;
          },
        };
      });

      const discovered = yield* discoverMcpToolsFromConnector({
        connect,
        namespace: "source.mcp",
        sourceKey: "mcp.demo",
      });

      expect(connectCalls).toBe(1);
      expect(closeCalls).toBe(1);
      expect(discovered.manifest.tools).toHaveLength(1);
      expect(discovered.manifest.server?.info?.name).toBe("mcp-demo-server");
      expect(discovered.manifest.tools[0]?.annotations?.readOnlyHint).toBe(true);
      expect(Object.keys(discovered.tools)).toEqual(["source.mcp.echo"]);

      const toolDefinition = resolveToolDefinition(discovered.tools["source.mcp.echo"]!);
      expect(toolDefinition.metadata?.sourceKey).toBe("mcp.demo");
      expect(JSON.stringify(toolDefinition.metadata?.contract?.inputSchema)).toContain("value");

      const invoke = resolveToolExecutor(discovered.tools, "source.mcp.echo");
      const invocationResult = yield* Effect.promise(() => invoke({ value: "hello" }));

      expect(invocationResult).toEqual({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      });
      expect(connectCalls).toBe(2);
      expect(closeCalls).toBe(2);
      expect(callInputs).toEqual([
        {
          name: "Echo",
          arguments: { value: "hello" },
        },
      ]);
    }),
  );

  it.scoped("discovers and invokes against a real streamable MCP server", () =>
    Effect.gen(function* () {
      const realServer = yield* makeRealMcpServer;

      const connect = createSdkMcpConnector({
        endpoint: realServer.endpoint,
        transport: "streamable-http",
      });

      const discovered = yield* discoverMcpToolsFromConnector({
        connect,
        namespace: "source.real",
        sourceKey: "mcp.real",
      });

      expect(Object.keys(discovered.tools)).toEqual(["source.real.echo"]);

      const toolDefinition = resolveToolDefinition(discovered.tools["source.real.echo"]!);
      expect(toolDefinition.metadata?.sourceKey).toBe("mcp.real");

      const invoke = resolveToolExecutor(discovered.tools, "source.real.echo");
      const invocationResult = yield* Effect.promise(() => invoke({ value: "from-test" }));

      expect(invocationResult).toEqual({
        content: [{ type: "text", text: "echo:from-test" }],
      });
      expect(realServer.seenValues).toEqual(["from-test"]);
    }),
  );

  it.scoped("does not consult authProvider when an Authorization header is already configured", () =>
    Effect.gen(function* () {
      const realServer = yield* makeAuthenticatedMcpServer("Bearer header-token");

      const discovered = yield* discoverMcpToolsFromConnector({
        connect: createSdkMcpConnector({
          endpoint: realServer.endpoint,
          transport: "streamable-http",
          headers: {
            Authorization: "Bearer header-token",
          },
          authProvider: makeThrowingAuthProvider(),
        }),
        namespace: "source.auth.header",
        sourceKey: "mcp.auth.header",
      });

      expect(Object.keys(discovered.tools)).toEqual(["source.auth.header.echo"]);
    }),
  );

  it.scoped("infers MCP OAuth only when discovery does not already include Authorization headers", () =>
    Effect.gen(function* () {
      const oauthServer = yield* makeOAuthProtectedMcpServer;

      const unauthenticated = yield* detectMcpSource({
        normalizedUrl: oauthServer.endpoint,
        headers: {},
      });
      expect(unauthenticated?.detectedKind).toBe("mcp");
      expect(unauthenticated?.authInference.suggestedKind).toBe("oauth2");

      const explicitHeader = yield* Effect.either(
        detectMcpSource({
          normalizedUrl: oauthServer.endpoint,
          headers: {
            Authorization: "Bearer wrong-token",
          },
        }),
      );
      assertTrue(Either.isLeft(explicitHeader));
    }),
  );


  it.effect("returns typed errors when listing tools fails", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(
        discoverMcpToolsFromConnector({
          connect: Effect.succeed({
            client: {
              listTools: async () => {
                throw new Error("nope");
              },
              callTool: async () => ({ ok: true }),
            },
            close: async () => undefined,
          }),
        }),
      );

      assertTrue(Either.isLeft(outcome));
      assertInstanceOf(outcome.left, McpToolsError);
      expect(outcome.left.stage).toBe("list_tools");
    }),
  );

  it.effect("returns typed errors when an MCP manifest has an invalid input schema", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(
        discoverMcpToolsFromConnector({
          connect: Effect.succeed({
            client: {
              listTools: async () => ({
                tools: [
                  {
                    name: "Echo",
                    description: "Echo payload",
                    inputSchema: {
                      type: "object",
                      properties: {
                        value: {
                          type: "not-a-real-type",
                        },
                      },
                    },
                  },
                ],
              }),
              callTool: async () => ({ ok: true }),
            },
            close: async () => undefined,
          }),
        }),
      );

      assertTrue(Either.isLeft(outcome));
      assertInstanceOf(outcome.left, McpToolsError);
      expect(outcome.left.stage).toBe("manifest");
    }),
  );

  it.effect("supports URL elicitation while discovering MCP tools", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const elicitationMessages: Array<string> = [];

      const discovered = yield* discoverMcpToolsFromConnector({
        connect: Effect.succeed({
          client: {
            listTools: async () => {
              attempts += 1;

              if (attempts === 1) {
                throw new UrlElicitationRequiredError([
                  {
                    mode: "url",
                    message: "Authorize tool discovery",
                    url: "https://example.com/authorize-discovery",
                    elicitationId: "discover-auth",
                  },
                ]);
              }

              return {
                tools: [
                  {
                    name: "Echo",
                    description: "Echo payload",
                    inputSchema: {
                      type: "object",
                      properties: {
                        value: { type: "string" },
                      },
                    },
                  },
                ],
              };
            },
            callTool: async () => ({ ok: true }),
          },
          close: async () => undefined,
        }),
        namespace: "source.mcp",
        sourceKey: "mcp.discovery",
        mcpDiscoveryElicitation: {
          onElicitation: ({ elicitation }) =>
            Effect.sync(() => {
              elicitationMessages.push(elicitation.message);
              return {
                action: "accept" as const,
              };
            }),
          path: "executor.sources.add" as ToolPath,
          sourceKey: "executor",
          args: {
            endpoint: "https://example.com/mcp",
          },
        },
      });

      expect(attempts).toBe(2);
      expect(elicitationMessages).toEqual(["Authorize tool discovery"]);
      expect(Object.keys(discovered.tools)).toEqual(["source.mcp.echo"]);
    }),
  );

  it.effect("surfaces elicitation callback failures during discovery", () =>
    Effect.gen(function* () {
      let requestHandler:
        | ((request: { params: unknown }) => Promise<unknown>)
        | undefined;

      const outcome = yield* Effect.either(
        discoverMcpToolsFromConnector({
          connect: Effect.succeed({
            client: {
              setRequestHandler: (
                _schema: unknown,
                handler: NonNullable<
                  McpClientLike & {
                    setRequestHandler: (
                      schema: unknown,
                      handler: (request: { params: unknown }) => Promise<unknown>,
                    ) => void;
                  }
                >["setRequestHandler"] extends (
                  schema: unknown,
                  handler: infer THandler,
                ) => void
                  ? THandler
                  : never,
              ) => {
                requestHandler = handler;
              },
              listTools: async () => {
                if (!requestHandler) {
                  throw new Error("missing request handler");
                }

                await requestHandler({
                  params: {
                    mode: "form",
                    message: "Authorize discovery",
                    requestedSchema: {},
                  },
                });

                return { tools: [] };
              },
              callTool: async () => ({ ok: true }),
            },
            close: async () => undefined,
          }),
          namespace: "source.mcp",
          sourceKey: "mcp.discovery",
          mcpDiscoveryElicitation: {
            onElicitation: () => Effect.fail(new Error("elicitation callback failed")),
            path: "executor.sources.add" as ToolPath,
            sourceKey: "executor",
            args: {
              endpoint: "https://example.com/mcp",
            },
          },
        }),
      );

      assertTrue(Either.isLeft(outcome));
      assertInstanceOf(outcome.left, McpToolsError);
      expect(outcome.left.stage).toBe("list_tools");
      expect(outcome.left.message).toContain("Failed listing MCP tools");
      expect(outcome.left.details).toContain("Failed resolving elicitation");
    }),
  );
});
