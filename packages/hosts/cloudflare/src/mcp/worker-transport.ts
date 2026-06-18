import { WorkerTransport, type WorkerTransportOptions } from "agents/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Data, Effect } from "effect";

import { JsonRpcRequestIdQueue } from "./request-id-queue.js";

export { JsonRpcRequestIdQueue, PREVIOUS_REQUEST_TIMEOUT_MS } from "./request-id-queue.js";

export class McpWorkerTransportError extends Data.TaggedError("McpWorkerTransportError")<{
  readonly cause: unknown;
}> {}

export type McpWorkerTransport = Readonly<{
  transport: WorkerTransport;
  connect: (server: McpServer) => Effect.Effect<void, McpWorkerTransportError>;
  handleRequest: (request: Request) => Effect.Effect<Response, McpWorkerTransportError>;
  close: () => Effect.Effect<void>;
}>;

export const makeMcpWorkerTransport = (
  options: WorkerTransportOptions,
): Effect.Effect<McpWorkerTransport> =>
  Effect.sync(() => {
    const transport = new WorkerTransport(options);
    const requestIdQueue = new JsonRpcRequestIdQueue();

    const use = <A>(name: string, fn: () => Promise<A>) =>
      Effect.tryPromise({
        try: fn,
        catch: (cause) => new McpWorkerTransportError({ cause }),
      }).pipe(Effect.withSpan(`mcp.worker_transport.${name}`));

    return {
      transport,
      connect: (server: McpServer) => use("connect", () => server.connect(transport)),
      handleRequest: (request: Request) =>
        use("handle_request", () =>
          requestIdQueue.run(request, () => transport.handleRequest(request)),
        ),
      close: () =>
        Effect.ignore(
          Effect.tryPromise({
            try: () => transport.close(),
            catch: (cause) => new McpWorkerTransportError({ cause }),
          }),
        ).pipe(Effect.withSpan("mcp.worker_transport.close")),
    } satisfies McpWorkerTransport;
  }).pipe(Effect.withSpan("mcp.worker_transport.make"));
