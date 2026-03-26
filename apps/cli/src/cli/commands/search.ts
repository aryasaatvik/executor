import * as Effect from "effect/Effect";
import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import { createExecutor } from "@executor/client";

import {
  ensureServer,
  printJson,
  printText,
  resolveSearchCommandDefaults,
  runCliEffect,
} from "../core";

const searchCommand = defineCommand({
  name: "search",
  description: "Search the workspace tool catalog",
  options: {
    source: option(z.string().optional(), {
      description: "Filter by source key",
    }),
    namespace: option(z.string().optional(), {
      description: "Filter by namespace",
    }),
    limit: option(z.coerce.number().int().positive().max(100).optional(), {
      description: "Maximum results to return",
    }),
    json: option(z.coerce.boolean().default(false), {
      description: "Print the full result as JSON",
    }),
    "base-url": option(z.string().optional(), {
      description: "Override the executor daemon base URL",
    }),
  },
  handler: async ({ flags, positional }) => {
    const query = positional.join(" ").trim();
    if (query.length === 0) {
      console.error("Provide a search query.");
      process.exitCode = 1;
      return;
    }

    const resolved = await runCliEffect(
      resolveSearchCommandDefaults({
        baseUrl: flags["base-url"],
        source: flags.source,
        namespace: flags.namespace,
        limit: flags.limit,
      }),
    );

    await runCliEffect(ensureServer(resolved.baseUrl));

    const executor = await createExecutor({ baseUrl: resolved.baseUrl });
    try {
      const result = await executor.catalog.search({
          query,
          source: resolved.source ?? null,
          namespace: resolved.namespace ?? null,
          limit: resolved.limit,
        });

      if (flags.json) {
        await runCliEffect(printJson(result));
        return;
      }

      const { meta, results } = result;
      await runCliEffect(
        printText(
          results.length === 0
            ? `No tools matched "${meta.query}".`
            : [
                `Found ${results.length} tool${results.length === 1 ? "" : "s"} for "${meta.query}" (${meta.mode}, ${meta.searchMode})`,
                ...results.map((entry, index) => {
                  const label = `${index + 1}. ${entry.path}`;
                  const context = [
                    `score=${entry.score.toFixed(3)}`,
                    `source=${entry.sourceKey}`,
                    `namespace=${entry.namespace}`,
                  ].join(" ");

                  return entry.description
                    ? `${label} ${context}\n   ${entry.description}`
                    : `${label} ${context}`;
                }),
              ].join("\n"),
        ),
      );
    } finally {
      await executor.close();
    }
  },
});

export default searchCommand;
