import {
  createServer as createNodeServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { FileSystem, HttpApiBuilder, HttpServer } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { type ControlPlane } from "@executor/core";
import { createLocalControlPlane } from "@executor/world-local";
import type { ExecutorDescriptor, HealthResponse } from "@executor/api";
import type {
  ResolveExecutionEnvironment,
} from "@executor/core/services/execution";
import type { ResolveSecretMaterial } from "@executor/core/services/engine/secret-material-store";
import { createExecutorMcpRequestHandler } from "@executor/executor-mcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import {
  DEFAULT_LOCAL_DATA_DIR,
  DEFAULT_SERVER_LOG_FILE,
  DEFAULT_SERVER_PID_FILE,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  EXECUTOR_TRACE_ENABLED_ENV,
  EXECUTOR_TRACE_OTLP_ENDPOINT_ENV,
  EXECUTOR_TRACE_OTLP_HTTP_ENDPOINT_ENV,
  EXECUTOR_TRACE_QUERY_BASE_URL_ENV,
  EXECUTOR_TRACE_SERVICE_NAME_ENV,
} from "./config";
import {
  createLocalTracingRuntimeFromEnv,
  tracingSearchUrl,
} from "./tracing";
import { platformServerEffectError } from "./effect-errors";
import { createEngineApiLayer } from "./api";

export {
  DEFAULT_EXECUTOR_DATA_DIR,
  DEFAULT_EXECUTOR_HOME,
  DEFAULT_LOCAL_DATA_DIR,
  DEFAULT_SERVER_BASE_URL,
  DEFAULT_SERVER_LOG_FILE,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PID_FILE,
  DEFAULT_SERVER_PORT,
  EXECUTOR_DATA_DIR_ENV,
  EXECUTOR_HOME_ENV,
  EXECUTOR_LOCAL_DATA_DIR_ENV,
  EXECUTOR_SERVER_PID_FILE_ENV,
  EXECUTOR_SERVER_LOG_FILE_ENV,
  EXECUTOR_WEB_ASSETS_DIR_ENV,
  EXECUTOR_TRACE_ENABLED_ENV,
  EXECUTOR_TRACE_OTLP_ENDPOINT_ENV,
  EXECUTOR_TRACE_OTLP_HTTP_ENDPOINT_ENV,
  EXECUTOR_TRACE_QUERY_BASE_URL_ENV,
  EXECUTOR_TRACE_SERVICE_NAME_ENV,
  SERVER_POLL_INTERVAL_MS,
  SERVER_START_TIMEOUT_MS,
} from "./config";

type StaticUiOptions = {
  readonly assetsDir?: string;
  readonly devServerUrl?: string;
};

export type LocalExecutorServer = {
  readonly controlPlane: ControlPlane;
  readonly port: number;
  readonly host: string;
  readonly baseUrl: string;
};

export type StartLocalExecutorServerOptions = {
  readonly port?: number;
  readonly host?: string;
  readonly localDataDir?: string;
  readonly workspaceRoot?: string;
  readonly pidFile?: string;
  readonly executionResolver?: ResolveExecutionEnvironment;
  readonly resolveSecretMaterial?: ResolveSecretMaterial;
  readonly ui?: StaticUiOptions;
};

export type LocalExecutorRequestHandler = {
  readonly controlPlane: ControlPlane;
  readonly handleApiRequest: (request: Request) => Promise<Response>;
  readonly getBaseUrl: () => string | undefined;
  readonly setBaseUrl: (baseUrl: string) => void;
};

type EngineWebHandler = ReturnType<typeof HttpApiBuilder.toWebHandler>;
type ExecutorMcpHandler = ReturnType<typeof createExecutorMcpRequestHandler>;
type RpcWebHandler = {
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
};

const disposeControlPlane = (cp: ControlPlane) =>
  Effect.tryPromise({
    try: () => cp.close(),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause ?? "control plane close failed")),
  }).pipe(Effect.orDie);

const bootstrapControlPlane = (
  localDataDir: string,
  getLocalServerBaseUrl: () => string | undefined,
  options: StartLocalExecutorServerOptions,
) =>
  createLocalControlPlane({
    localDataDir,
    workspaceRoot: options.workspaceRoot,
    executionResolver: options.executionResolver,
    resolveSecretMaterial: options.resolveSecretMaterial,
    getLocalServerBaseUrl,
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    ),
  );

const createHttpWebHandler = (
  cp: ControlPlane,
  tracingRuntime: ReturnType<typeof createLocalTracingRuntimeFromEnv>,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpApiBuilder.toWebHandler(
        Layer.merge(
          HttpApiBuilder.middlewareOpenApi({ path: "/v1/openapi.json" }).pipe(
            Layer.provideMerge(
              createEngineApiLayer(
                cp.runtimeLayer as unknown as Layer.Layer<any, never, never>,
              ).pipe(
                Layer.provideMerge(tracingRuntime?.layer ?? Layer.empty),
              ),
            ),
          ) as Layer.Layer<any, never, never>,
          HttpServer.layerContext,
        ),
      ),
    ),
    (handler: EngineWebHandler) => Effect.tryPromise({ try: () => handler.dispose(), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause ?? "web handler dispose failed")) }).pipe(Effect.orDie),
  );

const createRpcWebHandler = (
  cp: ControlPlane,
): Effect.Effect<RpcWebHandler, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      RpcServer.toWebHandler(ExecutorRpcs, {
        layer: Layer.mergeAll(
          ExecutorRpcHandlerLive,
          RpcSerialization.layerNdjson,
          HttpServer.layerContext,
        ).pipe(
          Layer.provide(
            Layer.merge(
              cp.runtimeLayer as unknown as Layer.Layer<any, never, never>,
              NodeFileSystem.layer,
            ),
          ),
        ),
      }),
    ),
    (handler: RpcWebHandler) =>
      Effect.tryPromise({
        try: () => handler.dispose(),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error(String(cause ?? "rpc handler dispose failed")),
      }).pipe(Effect.orDie),
  );

const safeFilePath = (assetsDir: string, pathname: string): string | null => {
  const target = resolve(assetsDir, `.${pathname}`);
  const root = resolve(assetsDir);
  return target.startsWith(root) ? target : null;
};

const isRegularFile = async (
  fileSystem: FileSystem.FileSystem,
  path: string,
): Promise<boolean> => {
  try {
    const info = await Effect.runPromise(fileSystem.stat(path));
    return info.type === "File";
  } catch {
    return false;
  }
};

const contentTypeByExtension: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const contentTypeForPath = (path: string): string =>
  contentTypeByExtension[extname(path).toLowerCase()] ?? "application/octet-stream";

const readResponseFile = async (
  fileSystem: FileSystem.FileSystem,
  path: string,
  contentType?: string,
): Promise<Response> => {
  const body = await Effect.runPromise(fileSystem.readFile(path));
  return new Response(Buffer.from(body), {
    headers: {
      "content-type": contentType ?? contentTypeForPath(path),
    },
  });
};

const toWebRequest = (nodeRequest: IncomingMessage): Request => {
  const host = nodeRequest.headers.host ?? "127.0.0.1";
  const url = `http://${host}${nodeRequest.url ?? "/"}`;
  const headers = new Headers();

  for (const [key, value] of Object.entries(nodeRequest.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    headers.set(key, value);
  }

  const method = nodeRequest.method ?? "GET";
  const requestInit: RequestInit & { duplex?: "half" } = {
    method,
    headers,
  };

  if (method !== "GET" && method !== "HEAD") {
    requestInit.body = Readable.toWeb(nodeRequest) as unknown as BodyInit;
    requestInit.duplex = "half";
  }

  return new Request(url, requestInit);
};

const writeNodeResponse = async (
  nodeResponse: ServerResponse,
  webResponse: Response,
): Promise<void> => {
  nodeResponse.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    nodeResponse.setHeader(key, value);
  });

  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }

  const reader = webResponse.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    nodeResponse.write(Buffer.from(value));
  }

  nodeResponse.end();
};


const wantsHtml = (request: Request): boolean =>
  request.headers.get("accept")?.includes("text/html") ?? false;

const serveUiAsset = async (
  fileSystem: FileSystem.FileSystem,
  request: Request,
  ui: StaticUiOptions,
): Promise<Response | null> => {
  const url = new URL(request.url);

  if (ui.devServerUrl) {
    const proxyUrl = new URL(`${url.pathname}${url.search}`, ui.devServerUrl);
    return fetch(new Request(proxyUrl.toString(), request));
  }

  if (!ui.assetsDir) {
    return null;
  }

  const candidatePath = safeFilePath(ui.assetsDir, url.pathname);
  if (candidatePath && await isRegularFile(fileSystem, candidatePath)) {
    return readResponseFile(fileSystem, candidatePath);
  }

  const shouldServeIndex =
    url.pathname === "/"
    || extname(url.pathname).length === 0
    || wantsHtml(request);

  if (!shouldServeIndex) {
    return null;
  }

  const indexPath = resolve(ui.assetsDir, "index.html");
  if (!(await isRegularFile(fileSystem, indexPath))) {
    return null;
  }

  return readResponseFile(fileSystem, indexPath, "text/html; charset=utf-8");
};

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-session-id",
  "access-control-max-age": "86400",
};

const withCors = (response: Response): Response => {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
};

const handleCorsPreflight = (request: Request): Response | null => {
  if (request.method !== "OPTIONS") return null;
  return withCors(new Response(null, { status: 204 }));
};

const EXECUTOR_VERSION =
  (globalThis as Record<string, unknown>).__EXECUTOR_VERSION as string | undefined
  ?? "0.0.0-dev";

const handleDiscover = (): Response =>
  withCors(Response.json({
    id: "local",
    name: "Executor (Local)",
    version: EXECUTOR_VERSION,
    capabilities: {
      runtimes: ["quickjs", "ses", "deno"],
      maxConcurrentExecutions: 8,
      supportsMcp: true,
      supportsOAuth: true,
    },
  } satisfies ExecutorDescriptor));

const handleHealth = (): Response =>
  withCors(Response.json({ status: "ok" } satisfies HealthResponse));

const isApiRequest = (request: Request): boolean => {
  const pathname = new URL(request.url).pathname;
  return pathname === "/mcp"
    || pathname === "/rpc"
    || pathname === "/discover"
    || pathname === "/health"
    || pathname === "/v1"
    || pathname.startsWith("/v1/");
};

export const createLocalExecutorRequestHandler = (
  options: StartLocalExecutorServerOptions = {},
): Effect.Effect<LocalExecutorRequestHandler, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const requestedLocalDataDir = options.localDataDir ?? DEFAULT_LOCAL_DATA_DIR;

    if (requestedLocalDataDir !== ":memory:") {
      yield* fileSystem.makeDirectory(dirname(requestedLocalDataDir), {
        recursive: true,
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );
    }

    let baseUrlRef: string | undefined;
    const tracingRuntime = createLocalTracingRuntimeFromEnv();

    if (tracingRuntime) {
      yield* Effect.sync(() => {
        console.info(
          `[executor] tracing enabled -> ${tracingSearchUrl({
            queryBaseUrl: tracingRuntime.queryBaseUrl,
            serviceName: tracingRuntime.serviceName,
          })}`,
        );
      });
    }

    const cp = yield* Effect.acquireRelease(
      bootstrapControlPlane(requestedLocalDataDir, () => baseUrlRef, options),
      disposeControlPlane,
    );

    const apiHandler = yield* createHttpWebHandler(cp, tracingRuntime);
    const rpcHandler = yield* createRpcWebHandler(cp);
    const mcpHandler = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createExecutorMcpRequestHandler({
          workspaceId: cp.installation.workspaceId,
          accountId: cp.installation.accountId,
          runtimeLayer: cp.runtimeLayer,
        })
      ),
      (handler: ExecutorMcpHandler) =>
        Effect.tryPromise({
          try: () => handler.close(),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error(String(cause ?? "mcp handler close failed")),
        }).pipe(Effect.orDie),
    );

    return {
      controlPlane: cp,
      handleApiRequest: async (request) => {
        const preflight = handleCorsPreflight(request);
        if (preflight) return preflight;

        const pathname = new URL(request.url).pathname;
        if (pathname === "/discover") return handleDiscover();
        if (pathname === "/health") return handleHealth();
        if (pathname === "/mcp") return mcpHandler.handleRequest(request);
        if (pathname === "/rpc") return rpcHandler.handler(request);

        // /v1/* routes — add CORS to response
        const response = await apiHandler.handler(request);
        return withCors(response);
      },
      getBaseUrl: () => baseUrlRef,
      setBaseUrl: (baseUrl) => {
        baseUrlRef = baseUrl;
      },
    } satisfies LocalExecutorRequestHandler;
  }).pipe(Effect.provide(NodeFileSystem.layer));

export const createLocalExecutorServer = (
  options: StartLocalExecutorServerOptions = {},
): Effect.Effect<LocalExecutorServer, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const host = options.host ?? DEFAULT_SERVER_HOST;
    const port = options.port ?? DEFAULT_SERVER_PORT;
    const requestHandler = yield* createLocalExecutorRequestHandler(options);

    const server = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<ReturnType<typeof createNodeServer>>((resolveServer, reject) => {
            const server = createNodeServer((nodeRequest, nodeResponse) => {
              void (async () => {
                const request = toWebRequest(nodeRequest);
                const response = isApiRequest(request)
                  ? await requestHandler.handleApiRequest(request)
                  : await serveUiAsset(fileSystem, request, options.ui ?? {}) ?? new Response("Not Found", { status: 404 });
                await writeNodeResponse(nodeResponse, response);
              })().catch((cause) => {
                nodeResponse.statusCode = 500;
                nodeResponse.end(cause instanceof Error ? cause.message : String(cause));
              });
            });

            server.once("error", reject);
            server.listen(port, host, () => {
              server.off("error", reject);
              resolveServer(server);
            });
          }),
        catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
      }),
      (server) => Effect.tryPromise({
        try: () =>
          new Promise<void>((resolveClose, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }

              resolveClose();
            });
          }),
        catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
      }).pipe(Effect.orDie),
    );

    const address = server.address();
    if (!address || typeof address === "string") {
      return yield* platformServerEffectError("index", "Failed to resolve local executor server address");
    }

    const resolvedAddress = address as AddressInfo;
    const baseUrl = `http://${host}:${resolvedAddress.port}`;
    requestHandler.setBaseUrl(baseUrl);

    return {
      controlPlane: requestHandler.controlPlane,
      host,
      port: resolvedAddress.port,
      baseUrl,
    } satisfies LocalExecutorServer;
  }).pipe(Effect.provide(NodeFileSystem.layer));

export const runLocalExecutorServer = (
  options: StartLocalExecutorServerOptions = {},
): Effect.Effect<void, Error, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const server = yield* createLocalExecutorServer(options);
      const pidFile = options.pidFile ?? DEFAULT_SERVER_PID_FILE;

      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(dirname(pidFile), {
            recursive: true,
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
            ),
          );
          yield* fileSystem.writeFileString(pidFile, JSON.stringify({
            pid: process.pid,
            port: server.port,
            host: server.host,
            baseUrl: server.baseUrl,
            startedAt: Date.now(),
            logFile: DEFAULT_SERVER_LOG_FILE,
          }, null, 2)).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
            ),
          );
        }),
        () =>
          fileSystem.remove(pidFile, { force: true }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error
                ? cause
                : new Error(String(cause ?? "pid file cleanup failed")),
            ),
            Effect.orDie,
          ),
      );

      console.error(`executor server listening on ${server.baseUrl}`);

      yield* Effect.async<void, never>((resume) => {
        const shutdown = () => resume(Effect.void);
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);

        return Effect.sync(() => {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
        });
      });
    }),
  ).pipe(Effect.provide(NodeFileSystem.layer));
