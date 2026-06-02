import { Context, Effect, Layer, ManagedRuntime } from "effect";

import { createExecutionEngine } from "@executor-js/execution/core";
import { makeLocalApiHandler } from "./app";
import { makeLocalCodeExecutor } from "./execution";
import { getExecutorBundle } from "./executor";
import { createMcpRequestHandler, type McpRequestHandler } from "./mcp";

// ---------------------------------------------------------------------------
// Local server handlers.
//
// The typed plugin `/api` is assembled by `ExecutorApp.make` (see `./app.ts`):
// the shared facade slotting local's single-user identity + the ONE boot
// executor (the `fixedExecution` seam) + console error capture + Swagger. The
// plugin set is the union of `executor.config.ts` (static, typed) and
// `executor.jsonc#plugins` (dynamic), resolved inside the boot bundle.
//
// The in-process `/mcp` surface stays local-platform: a single-engine handler
// over the SAME boot executor with a browser-approval store + stdio transport
// (not the shared multi-user `McpServingRoutes` envelope), built here and routed
// by the Bun shell in `serve.ts`.
// ---------------------------------------------------------------------------

export type ServerHandlers = {
  readonly api: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
  };
  readonly mcp: McpRequestHandler;
};

const closeServerHandlers = async (handlers: ServerHandlers): Promise<void> => {
  await Effect.runPromise(
    Effect.all(
      [
        Effect.tryPromise({
          try: () => handlers.api.dispose(),
          catch: (cause) => cause,
        }).pipe(Effect.ignore),
        Effect.tryPromise({
          try: () => handlers.mcp.close(),
          catch: (cause) => cause,
        }).pipe(Effect.ignore),
      ],
      { concurrency: "unbounded" },
    ),
  );
};

export const createServerHandlers = async (): Promise<ServerHandlers> => {
  // The typed `/api` web-handler comes from `ExecutorApp.make` (./app.ts).
  const apiHandler: ServerHandlers["api"] = await makeLocalApiHandler();

  // The in-process MCP server runs over the SAME boot executor, with its own
  // engine instance (the browser-approval + stdio surface is local-only and not
  // part of the shared API). Reuse the shared boot bundle so the MCP executor is
  // byte-identical to the one the API serves.
  const { executor } = await getExecutorBundle();
  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeLocalCodeExecutor(),
  });
  const mcp = createMcpRequestHandler({ engine });

  return { api: apiHandler, mcp };
};

export class ServerHandlersService extends Context.Service<ServerHandlersService, ServerHandlers>()(
  "@executor-js/local/ServerHandlersService",
) {}

const ServerHandlersLive = Layer.effect(ServerHandlersService)(
  Effect.acquireRelease(
    Effect.promise(() => createServerHandlers()),
    (handlers) => Effect.promise(() => closeServerHandlers(handlers)),
  ),
);

const serverHandlersRuntime = ManagedRuntime.make(ServerHandlersLive);

export const getServerHandlers = (): Promise<ServerHandlers> =>
  serverHandlersRuntime.runPromise(ServerHandlersService.asEffect());

export const disposeServerHandlers = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => serverHandlersRuntime.dispose(),
      catch: (cause) => cause,
    }).pipe(Effect.ignore),
  );
};
