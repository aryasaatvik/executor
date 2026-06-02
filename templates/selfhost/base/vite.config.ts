import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import appPlugin from "@executor-js/app/vite";

// ---------------------------------------------------------------------------
// Self-host web SPA. The shared @executor-js/app multiplayer shell IS the Vite
// root — it ships its own index.html, public assets, and TanStack routes
// (the Better-Auth-gated multiplayer shell, exactly what a multi-user self-host
// wants), so the thin repo has no `web/` directory of its own.
// `@executor-js/app/vite` (`appPlugin`) wires Tailwind, the TanStack router
// codegen, and the `@executor-js/vite-plugin` that feeds this app's
// executor.config.ts plugin list into `virtual:executor/plugins-client`.
//
// `vite build` emits a static bundle to ./dist; `src/serve.ts` serves it from
// there (`HttpStaticServer` with `spa: true`) alongside the Effect API
// (/api, /api/auth, /mcp, /docs). One Bun process — no separate web server.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
// The shared app package directory is the Vite root (its index.html + public/).
const APP_ROOT = dirname(require.resolve("@executor-js/app/index.html"));
const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: APP_ROOT,
  build: {
    outDir: `${HERE}/dist`,
    emptyOutDir: true,
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify("0.0.0-selfhost"),
    "import.meta.env.VITE_GITHUB_URL": JSON.stringify("https://github.com/RhysSullivan/executor"),
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
