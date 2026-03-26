import * as Effect from "effect/Effect";
import { defineCommand, option } from "@bunli/core";
import { z } from "zod";

import { resolveCallCommandDefaults, runCliEffect, runResume } from "../core";

const resumeCommand = defineCommand({
  name: "resume",
  description: "Resume a paused execution",
  options: {
    "execution-id": option(z.string().min(1), {
      description: "Execution ID to resume",
    }),
    "base-url": option(z.string().optional(), {
      description: "Override the executor daemon base URL",
    }),
    "no-open": option(z.coerce.boolean().optional(), {
      description: "Print interaction URLs without opening a browser",
    }),
  },
  handler: async ({ flags }) => {
    await runCliEffect(
      resolveCallCommandDefaults({
        baseUrl: flags["base-url"],
        noOpen: flags["no-open"],
      }).pipe(
        Effect.flatMap((resolved) =>
          runResume({
            executionId: flags["execution-id"],
            baseUrl: resolved.baseUrl,
            noOpen: resolved.noOpen,
          }),
        ),
      ),
    );
  },
});

export default resumeCommand;
