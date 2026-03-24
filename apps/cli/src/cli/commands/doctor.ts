import { defineCommand, option } from "@bunli/core";
import * as Effect from "effect/Effect";
import { z } from "zod";

import {
  getDoctorReport,
  printJson,
  printText,
  renderDoctorReport,
  runCliEffect,
} from "../core";

const doctorCommand = defineCommand({
  name: "doctor",
  description: "Check local executor install and daemon health",
  options: {
    "base-url": option(z.string().default("http://127.0.0.1:8788"), {
      description: "Override the executor daemon base URL",
    }),
    json: option(z.coerce.boolean().default(false), {
      description: "Print the full report as JSON",
    }),
  },
  handler: async ({ flags }) => {
    await runCliEffect(
      getDoctorReport(flags["base-url"]).pipe(
        Effect.flatMap((report) =>
          flags.json ? printJson(report) : printText(renderDoctorReport(report)),
        ),
      ),
    );
  },
});

export default doctorCommand;
