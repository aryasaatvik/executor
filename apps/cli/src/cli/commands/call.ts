import { defineCommand, option } from "@bunli/core";
import { z } from "zod";

import { runCall, runCliEffect } from "../core";

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
    "base-url": option(z.string().default("http://127.0.0.1:8788"), {
      description: "Override the executor daemon base URL",
    }),
    "no-open": option(z.coerce.boolean().default(false), {
      description: "Print interaction URLs without opening a browser",
    }),
  },
  handler: async ({ flags, positional }) => {
    await runCliEffect(
      runCall({
        code: positional[0],
        file: flags.file,
        stdin: flags.stdin,
        baseUrl: flags["base-url"],
        noOpen: flags["no-open"],
      }),
    );
  },
});

export default callCommand;
