import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import appPlugin from "@executor-js/app/vite";

// ---------------------------------------------------------------------------
// Cloudflare web SPA. The shared @executor-js/app multiplayer shell IS the Vite
// root — it ships its own index.html, public assets, and TanStack routes, so the
// thin repo has no `web/` directory of its own. `@executor-js/app/vite`
// (`appPlugin`) wires Tailwind, the TanStack router codegen, and the
// `@executor-js/vite-plugin` that feeds this app's executor.config.ts plugin
// list into `virtual:executor/plugins-client`.
//
// `vite build` emits a static bundle to ./dist, which wrangler serves via
// Workers Static Assets (see wrangler.jsonc `assets`). No dev /api middleware
// here — run `wrangler dev`, which serves the built SPA + the Worker API
// together.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
// The shared app package directory is the Vite root (its index.html + public/).
const APP_ROOT = dirname(require.resolve("@executor-js/app/index.html"));
const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: APP_ROOT,
  resolve: {
    // The @executor-js/cloudflare host adapter is vendored into this repo (see
    // the cloudflare-adapter registry block) under src/cloudflare/**. Map the
    // package specifiers onto the owned source so the MCP glue imports it by
    // name with no rewrite. The named subpaths mirror the upstream `exports`
    // map (note: `/mcp/durable-object` -> session-durable-object.ts). Most
    // specific entries first — Vite resolves aliases in array order.
    alias: [
      {
        find: "@executor-js/cloudflare/mcp/worker-transport",
        replacement: `${HERE}/src/cloudflare/mcp/worker-transport.ts`,
      },
      {
        find: "@executor-js/cloudflare/mcp/do-headers",
        replacement: `${HERE}/src/cloudflare/mcp/do-headers.ts`,
      },
      {
        find: "@executor-js/cloudflare/mcp/response-peek",
        replacement: `${HERE}/src/cloudflare/mcp/response-peek.ts`,
      },
      {
        find: "@executor-js/cloudflare/mcp/session-store",
        replacement: `${HERE}/src/cloudflare/mcp/session-store.ts`,
      },
      {
        find: "@executor-js/cloudflare/mcp/durable-object",
        replacement: `${HERE}/src/cloudflare/mcp/session-durable-object.ts`,
      },
      {
        find: "@executor-js/cloudflare",
        replacement: `${HERE}/src/cloudflare/index.ts`,
      },
    ],
  },
  build: {
    outDir: `${HERE}/dist`,
    emptyOutDir: true,
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("0.0.0-cloudflare"),
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
  server: {
    fs: { allow: [APP_ROOT, HERE] },
  },
  plugins: [
    appPlugin({
      executorConfigPath: `${HERE}/executor.config.ts`,
    }),
  ],
});
