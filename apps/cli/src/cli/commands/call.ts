import * as Effect from "effect/Effect";
import { defineCommand, option } from "@bunli/core";
import { z } from "zod";

import { resolveCallCommandDefaults, runCall, runCliEffect } from "../core";

const callCommand = defineCommand({
  name: "call",
  description: "Execute code against the local executor daemon",
  options: {
    file: option(z.string().optional(), {
      description: "Read code from a file",
    }),
    stdin: option(z.coerce.boolean().default(false), {
      description: "Read code from stdin",
    }),
    "base-url": option(z.string().optional(), {
      description: "Override the executor daemon base URL",
    }),
    "no-open": option(z.coerce.boolean().optional(), {
      description: "Print interaction URLs without opening a browser",
    }),
  },
  handler: async ({ flags, positional }) => {
    await runCliEffect(
      resolveCallCommandDefaults({
        baseUrl: flags["base-url"],
        noOpen: flags["no-open"],
      }).pipe(
        Effect.flatMap((resolved) =>
          runCall({
            code: positional[0],
            file: flags.file,
            stdin: flags.stdin,
            baseUrl: resolved.baseUrl,
            noOpen: resolved.noOpen,
          }),
        ),
      ),
    );
  },
});

export default callCommand;
