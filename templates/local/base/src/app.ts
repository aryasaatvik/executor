import { HttpApiSwagger } from "effect/unstable/httpapi";
import { Layer } from "effect";

import {
  composePluginApi,
  ExecutorApp,
  FixedExecutionProvider,
  textFailureStrategy,
} from "@executor-js/api/server";
import { createExecutionEngine } from "@executor-js/execution/core";

import { getExecutorBundle, type LocalExecutor } from "./executor";
import { makeLocalCodeExecutor } from "./execution";
import { localIdentityLayer } from "./identity";
import { ErrorCaptureLive } from "./observability";

// ===========================================================================
// The LOCAL Executor app, as ONE `ExecutorApp.make` call.
//
// Single-user identity (always the one local Principal) over a SINGLE
// boot-built executor scoped to the working directory, QuickJS in-process code
// execution (the `./execution` engine seam), console error capture, Swagger at
// /docs — and NO account API, NO MCP envelope (local's /mcp is its own
// in-process surface in serve.ts). Local serves its ONE cwd executor directly
// (the `fixedExecution` seam) instead of building a per-request scoped executor
// from identity.
//
// `ExecutorApp.make` owns the assembly (the fixed-execution middleware wrapping
// the protected API, the extension routes, provideMerge(boot)). This file's job
// is the eager async boot — building the ONE executor + engine — and slotting
// local's seam Layers into the named slots. `mountPrefix` is left at root: the
// Bun shell (serve.ts) strips `/api` before dispatching here.
// ===========================================================================

/**
 * The fixed-execution seam: the ONE boot executor + engine + plugin extension
 * map, projected under `FixedExecutionProvider`. The executor already holds its
 * cwd scope, SQLite db handle, plugins, and `allowHttp` policy (built in
 * `executor.ts`), so local supplies no `DbProvider`/`PluginsProvider`/
 * `HostConfig`/`CodeExecutorProvider` seams — the fixed executor is the whole
 * execution model.
 */
const localFixedExecutionLayer = (executor: LocalExecutor): Layer.Layer<FixedExecutionProvider> =>
  Layer.succeed(FixedExecutionProvider)({
    executor,
    engine: createExecutionEngine({
      executor,
      codeExecutor: makeLocalCodeExecutor(),
    }),
    // The executor IS its own plugin-extension map (`executor[pluginId]`); the
    // fixed middleware reads `executor[id]` to satisfy each plugin's
    // `*ExtensionService` Tag per request.
    extensions: executor,
  });

export interface LocalApiHandler {
  /** The unified web handler: serves the typed API (at root — the Bun shell strips `/api`) + /docs. */
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

/**
 * Build the local app's API web-handler. Awaits the shared boot bundle (the one
 * cwd-scoped executor), then composes `ExecutorApp.make` over local's seams and
 * binds it to a `fetch`-style handler.
 */
export const makeLocalApiHandler = async (): Promise<LocalApiHandler> => {
  const { executor, plugins } = await getExecutorBundle();

  // Build the fixed-execution seam ONCE (one executor + one engine). The same
  // Layer is the `fixedExecution` seam declaration AND lives in `boot` so the
  // fixed middleware's residual `FixedExecutionProvider` resolves there.
  const fixedExecution = localFixedExecutionLayer(executor);

  const { toWebHandler } = ExecutorApp.make({
    plugins,
    providers: {
      // Single-user: always resolves the one local Principal. Boot-scoped
      // (`RIdentity = never`), captured once.
      identity: localIdentityLayer,
      // The ONE boot executor + engine, served directly — local's fixed
      // execution model (no per-request scoped-executor rebuild).
      fixedExecution,
      // account omitted (local has no account API).
      // mcp omitted (local's /mcp is its own in-process surface in serve.ts).
      errorCapture: ErrorCaptureLive,
    },
    extensions: {
      // Swagger UI at /docs, over the root-mounted spec (local serves the API at
      // root; the Bun shell strips `/api`).
      routes: [HttpApiSwagger.layer(composePluginApi(plugins), { path: "/docs" })],
    },
    // No mountPrefix: local serves the typed API at root and the Bun shell strips
    // the `/api` prefix before dispatching here. Local renders identity failures
    // as text; the single-user provider never produces one in practice.
    config: { failure: textFailureStrategy },
    // The boot-scoped context provideMerge'd under everything: the identity
    // provider + the fixed execution seam (the one executor + engine + extension map).
    boot: Layer.merge(localIdentityLayer, fixedExecution),
  });

  const web = toWebHandler();
  return { handler: web.handler, dispose: web.dispose };
};
