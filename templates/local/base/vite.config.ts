import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import { defineConfig, type Plugin } from "vite";
import appPlugin from "@executor-js/app/vite";

// ---------------------------------------------------------------------------
// Local web SPA + dev API proxy.
//
// The shared @executor-js/app multiplayer shell IS the Vite root — it ships its
// own index.html, public assets, and TanStack routes, so this thin repo has no
// `web/` directory of its own. `@executor-js/app/vite` (`appPlugin`) wires
// Tailwind, the TanStack router codegen, and the `@executor-js/vite-plugin` that
// feeds this app's executor.config.ts plugin list into
// `virtual:executor/plugins-client`.
//
// In dev, `executorApiPlugin` forwards /api and /mcp to the in-process Effect
// handlers (the SAME handlers serve.ts uses) so `vite dev` is a complete app —
// no separate server process. `vite build` emits a static bundle to ./dist that
// `bun run src/serve.ts` then serves.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
// The shared app package directory is the Vite root (its index.html + public/).
const APP_ROOT = dirname(require.resolve("@executor-js/app/index.html"));
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Vite plugin that forwards /api and /mcp requests to the Effect handlers during
 * development, so you don't need a separate server process. Reloads the handlers
 * when src or executor.config.ts changes.
 */
function executorApiPlugin(): Plugin {
  let handlers: import("./src/main").ServerHandlers | null = null;

  return {
    name: "executor-api",
    configureServer(server) {
      server.watcher.on("change", (path) => {
        if (path.includes(`${HERE}/src/`) || path.endsWith("/executor.config.ts")) {
          handlers = null;
        }
      });
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? "/";
        const isApi = rawUrl.startsWith("/api/") || rawUrl === "/api";
        const isMcp = rawUrl.startsWith("/mcp");

        if (!isApi && !isMcp) return next();

        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Vite middleware must convert handler failures into HTTP 500 responses
        try {
          if (!handlers) {
            const { getServerHandlers } = await import("./src/main");
            handlers = await getServerHandlers();
          }

          const origin = `http://${req.headers.host ?? "localhost"}`;
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          }

          // Strip /api prefix for the Effect handlers (they serve at root).
          const url = isApi ? rawUrl.slice("/api".length) || "/" : rawUrl;

          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const webRequest = new Request(new URL(url, origin), {
            method: req.method,
            headers,
            body: hasBody ? Readable.toWeb(req) : undefined,
            duplex: hasBody ? "half" : undefined,
          } as RequestInit);

          const response = isMcp
            ? await handlers.mcp.handleRequest(webRequest)
            : await handlers.api.handler(webRequest);

          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));

          if (response.body) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          }
          res.end();
        } catch (err) {
          console.error("[executor-api]", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        }
      });
    },
  };
}

export default defineConfig({
  root: APP_ROOT,
  publicDir: resolve(APP_ROOT, "public"),
  build: {
    outDir: `${HERE}/dist`,
    emptyOutDir: true,
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("0.0.0-local"),
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: parseInt(process.env.PORT ?? "5173", 10),
    host: "127.0.0.1",
    fs: { allow: [APP_ROOT, HERE] },
  },
  plugins: [
    appPlugin({
      executorConfigPath: `${HERE}/executor.config.ts`,
      executorJsoncPath: `${HERE}/executor.jsonc`,
    }),
    executorApiPlugin(),
  ],
});
