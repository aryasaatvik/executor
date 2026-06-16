import type { Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";

import type { ToolDocumentInput } from "./chunker";
import { SemanticSearchError } from "./errors";

const ADDRESS_PREFIX = "tools.";

/** Strip the proxy-root `tools.` prefix so the address becomes the
 *  sandbox-callable path the model writes after `tools.` — mirrors the engine's
 *  own `addressToPath` so the `path` we index matches what `tools.search`
 *  callers expect (and can pass back to `describe`/invoke). */
export const addressToPath = (address: string): string =>
  address.startsWith(ADDRESS_PREFIX) ? address.slice(ADDRESS_PREFIX.length) : address;

/** Collect the full `ToolDocumentInput` set from the live catalog.
 *
 *  For each tool returned by `tools.list`, we attempt to fetch its schema via
 *  `tools.schema(address)` to populate the TypeScript facets (inputTypeScript,
 *  outputTypeScript, typeScriptDefinitions). If the schema fetch fails for any
 *  individual tool we degrade gracefully to an identity-only document (no TS
 *  fields) — never failing the whole collection for one tool.
 *
 *  Bounded concurrency (16) keeps the catalog walk fast while avoiding
 *  unbounded fan-out. */
export const collectToolDocumentInputs = (
  namespace: string,
  executor: Executor,
): Effect.Effect<readonly ToolDocumentInput[], SemanticSearchError> =>
  executor.tools.list({ includeAnnotations: false }).pipe(
    Effect.mapError(
      (cause) => new SemanticSearchError({ message: "Failed to list tools for indexing.", cause }),
    ),
    Effect.flatMap((tools) =>
      Effect.forEach(
        tools,
        (tool) => {
          const path = addressToPath(String(tool.address));
          const base: ToolDocumentInput = {
            path,
            name: String(tool.name),
            integration: String(tool.integration),
            description: tool.description,
          };
          // Attempt schema fetch; on any failure degrade to identity-only.
          return executor.tools.schema(tool.address).pipe(
            Effect.map((view): ToolDocumentInput => {
              if (view === null) return base;
              return {
                ...base,
                ...(view.inputTypeScript !== undefined
                  ? { inputTypeScript: view.inputTypeScript }
                  : {}),
                ...(view.outputTypeScript !== undefined
                  ? { outputTypeScript: view.outputTypeScript }
                  : {}),
                ...(view.typeScriptDefinitions !== undefined
                  ? { typeScriptDefinitions: view.typeScriptDefinitions }
                  : {}),
              };
            }),
            // Degrade: schema fetch failed — use identity-only document.
            Effect.catch(() => Effect.succeed(base)),
          );
        },
        { concurrency: 16 },
      ),
    ),
  );
