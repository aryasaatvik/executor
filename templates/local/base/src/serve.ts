/**
 * Production Bun server for the local single-user Executor host.
 *
 * Serves the Vite-built SPA + the Effect `/api` + the in-process MCP server.
 *
 * Run directly:   bun run src/serve.ts
 * Or import:      import { startServer } from "./serve"
 */

import { resolve, join } from "node:path";
import { readdirSync } from "node:fs";
import { setOAuthCompletionListener } from "@executor-js/api";
import { consumeOAuthResult, publishOAuthResult } from "./oauth-result-store";
import { getServerHandlers } from "./main";
import {
  DEFAULT_ALLOWED_HOSTS,
  hasFileExtension,
  isLoopbackBindHost,
  isUnauthenticatedOAuthCallbackPath,
  makeIsAllowedHost,
  makeIsAuthorized,
  normalizeCredential,
} from "./serve-shared";

// ---------------------------------------------------------------------------
// Static files — served from the Vite-built ./dist directory on disk.
// ---------------------------------------------------------------------------

type StaticHandler = () => Response | Promise<Response>;

function collectStaticRoutes(dir: string, prefix = ""): Record<string, StaticHandler> {
  const routes: Record<string, StaticHandler> = {};
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: filesystem route discovery is best-effort for optional built assets
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const routePath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        Object.assign(routes, collectStaticRoutes(fullPath, routePath));
      } else {
        const file = Bun.file(fullPath);
        routes[routePath] = () =>
          new Response(file, {
            headers: { "content-type": file.type || "application/octet-stream" },
          });
      }
    }
  } catch {}
  return routes;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface StartServerOptions {
  port?: number;
  /** Directory containing built client assets. Defaults to ./dist. */
  clientDir?: string;
  /** Bind address. Defaults to 127.0.0.1. Use 0.0.0.0 to listen on all interfaces. */
  hostname?: string;
  /** Extra hostnames permitted in the Host header, on top of localhost/127.0.0.1. */
  allowedHosts?: ReadonlyArray<string>;
  /** Bearer token required for requests. Required for non-loopback bind addresses. */
  authToken?: string;
  /** Basic auth password required for requests. Required for non-loopback bind addresses. */
  authPassword?: string;
}

export interface ServerInstance {
  port: number;
  stop: () => Promise<void>;
}

const corsHeaders = {
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, x-executor-token, x-requested-with, traceparent, tracestate, baggage, b3",
  "access-control-allow-credentials": "true",
  "access-control-expose-headers": "*",
} as const;

const withCorsHeaders = (req: Request, response: Response): Response => {
  const origin = req.headers.get("origin");
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  headers.set(
    "access-control-allow-headers",
    req.headers.get("access-control-request-headers") ??
      corsHeaders["access-control-allow-headers"],
  );
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const corsPreflightResponse = (req: Request): Response =>
  withCorsHeaders(req, new Response(null, { status: 204 }));

export async function startServer(opts: StartServerOptions = {}): Promise<ServerInstance> {
  const port = opts.port ?? parseInt(process.env.PORT ?? "4788", 10);
  const hostname = opts.hostname ?? process.env.EXECUTOR_HOST ?? "127.0.0.1";
  const auth = {
    token: normalizeCredential(opts.authToken ?? process.env.EXECUTOR_AUTH_TOKEN),
    password: normalizeCredential(opts.authPassword ?? process.env.EXECUTOR_AUTH_PASSWORD),
  };
  const isNetworkBind = !isLoopbackBindHost(hostname);
  const requiresAuth = auth.token !== null || auth.password !== null;
  if (isNetworkBind && !requiresAuth) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: startServer is a Promise API and rejects invalid bind options
    throw new Error(
      "Refusing to listen on a non-loopback host without an auth token or password (set EXECUTOR_AUTH_TOKEN or EXECUTOR_AUTH_PASSWORD).",
    );
  }
  const isAuthorized = makeIsAuthorized(auth);
  const allowedHostSet = new Set<string>([...DEFAULT_ALLOWED_HOSTS, ...(opts.allowedHosts ?? [])]);
  const isAllowedHost = makeIsAllowedHost(allowedHostSet);
  const clientDir = opts.clientDir ?? resolve(import.meta.dirname, "../dist");

  const handlers = await getServerHandlers();

  // Mirror every OAuth callback completion into the local in-memory result
  // store, so a client that ran the flow in an external browser can poll
  // /api/oauth/await/:sessionId for the result (no shared origin → no
  // postMessage). See setOAuthCompletionListener.
  setOAuthCompletionListener((result) => publishOAuthResult(result));

  const staticRoutes = collectStaticRoutes(clientDir);
  const indexFile = Bun.file(join(clientDir, "index.html"));
  const serveIndex: StaticHandler = () =>
    new Response(indexFile, { headers: { "content-type": "text/html" } });

  const server = Bun.serve({
    port,
    hostname,
    // Disable Bun's default 10s idle timeout. MCP elicitation and pause/resume
    // can idle longer during human approval; `0` disables the socket timeout.
    idleTimeout: 0,
    routes: { ...staticRoutes },
    async fetch(req) {
      const maybeWithCorsHeaders = (response: Response): Response =>
        requiresAuth ? withCorsHeaders(req, response) : response;

      if (!isAllowedHost(req)) {
        return maybeWithCorsHeaders(new Response("Forbidden", { status: 403 }));
      }

      if (requiresAuth && req.method === "OPTIONS" && req.headers.has("origin")) {
        return corsPreflightResponse(req);
      }

      const url = new URL(req.url);

      // OAuth provider callbacks are hit by the user's external browser and
      // can't carry our Basic auth header. The OAuth `state` parameter is the
      // security gate — see isUnauthenticatedOAuthCallbackPath.
      const skipAuth = isUnauthenticatedOAuthCallbackPath(url.pathname);

      if (requiresAuth && !skipAuth && !isAuthorized(req)) {
        return maybeWithCorsHeaders(
          new Response("Unauthorized", {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="executor", Basic realm="executor"' },
          }),
        );
      }

      if (url.pathname.startsWith("/mcp")) {
        return maybeWithCorsHeaders(await handlers.mcp.handleRequest(req));
      }

      if (url.pathname.startsWith("/api/mcp-sessions/")) {
        return maybeWithCorsHeaders(await handlers.mcp.handleApprovalRequest(req));
      }

      // OAuth result polling — local-only, served outside the typed API.
      const awaitMatch = /^\/api\/oauth\/await\/([^/?#]+)$/.exec(url.pathname);
      if (awaitMatch && req.method === "GET") {
        const result = consumeOAuthResult(awaitMatch[1]);
        return maybeWithCorsHeaders(
          new Response(JSON.stringify(result), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
        url.pathname = url.pathname.slice("/api".length) || "/";
        return maybeWithCorsHeaders(await handlers.api.handler(new Request(url, req)));
      }

      // If a path looks like a static asset (has a file extension), do not fall
      // back to SPA HTML. Returning index.html here causes browser module MIME
      // errors when hashed chunks are stale/missing.
      if (hasFileExtension(url.pathname)) {
        return maybeWithCorsHeaders(new Response("Not Found", { status: 404 }));
      }

      // SPA fallback
      return maybeWithCorsHeaders(await serveIndex());
    },
    error(error) {
      console.error("Server error:", error);
      return new Response("Internal Server Error", { status: 500 });
    },
  });

  return {
    port: server.port!,
    async stop() {
      setOAuthCompletionListener(null);
      server.stop(true);
      await handlers.mcp.close();
      await handlers.api.dispose();
    },
  };
}

if (import.meta.main) {
  const server = await startServer();
  console.log(`Executor listening on http://localhost:${server.port}`);
}
