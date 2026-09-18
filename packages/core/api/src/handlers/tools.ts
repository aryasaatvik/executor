import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { ToolNotFoundError, type Tool } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

const toMetadata = (t: Tool) => ({
  address: t.address,
  owner: t.owner,
  integration: t.integration,
  connection: t.connection,
  name: t.name,
  pluginId: t.pluginId,
  description: t.description,
  mayElicit: t.annotations?.mayElicit,
  requiresApproval: t.annotations?.requiresApproval,
  approvalDescription: t.annotations?.approvalDescription,
  static: t.static,
});

export const ToolsHandlers = HttpApiBuilder.group(ExecutorApi, "tools", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const tools = yield* executor.tools.list({
            integration: query.integration,
            owner: query.owner,
            connection: query.connection,
            query: query.query,
            includeAnnotations: query.includeAnnotations === "true",
            includeBlocked: query.includeBlocked !== "false",
          });
          return tools.map(toMetadata);
        }),
      ),
    )
    .handle("schema", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const schema = yield* executor.tools.schema(query.address);
          if (schema === null) {
            return yield* new ToolNotFoundError({ address: query.address });
          }
          return schema;
        }),
      ),
    )
    .handle("listSchemas", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          // Bound every response: the bulk surface exists so one Worker request
          // never has to materialize a whole catalog. Callers page with `after`.
          const requested = query.limit === undefined ? 200 : Number(query.limit);
          const limit =
            Number.isFinite(requested) && requested > 0
              ? Math.min(Math.floor(requested), 500)
              : 200;
          const schemas = yield* executor.tools.schemas({
            ...(query.integration === undefined ? {} : { integration: query.integration }),
            ...(query.owner === undefined ? {} : { owner: query.owner }),
            ...(query.connection === undefined ? {} : { connection: query.connection }),
            includeBlocked: query.includeBlocked === "true",
            limit,
            ...(query.after === undefined || query.after === "" ? {} : { after: query.after }),
          });
          return schemas;
        }),
      ),
    ),
);
