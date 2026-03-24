import { defineCommand, option } from "@bunli/core";
import { z } from "zod";

import { runCliEffect, runResume } from "../core";

const resumeCommand = defineCommand({
  name: "resume",
  description: "Resume a paused execution",
  options: {
    "execution-id": option(z.string().min(1), {
      description: "Execution ID to resume",
    }),
    "base-url": option(z.string().default("http://127.0.0.1:8788"), {
      description: "Override the executor daemon base URL",
    }),
    "no-open": option(z.coerce.boolean().default(false), {
      description: "Print interaction URLs without opening a browser",
    }),
  },
  handler: async ({ flags }) => {
    await runCliEffect(
      runResume({
        executionId: flags["execution-id"],
        baseUrl: flags["base-url"],
        noOpen: flags["no-open"],
      }),
    );
  },
});

export default resumeCommand;
