import { createCLI } from "@bunli/core";
import { completionsPlugin } from "@bunli/plugin-completions";
import { resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };

import callCommand from "./commands/call";
import configCommand from "./commands/config";
import daemonGroup from "./commands/daemon";
import doctorCommand from "./commands/doctor";
import resumeCommand from "./commands/resume";
import searchCommand from "./commands/search";

export const createExecutorCli = async () => {
  const commandName = Object.keys(pkg.bin ?? {})[0] ?? "executor";
  const generatedPath = resolve(import.meta.dir, "..", ".bunli/commands.gen.ts");
  const cli = await createCLI({
    name: "executor",
    version: pkg.version,
    description: "Local AI executor CLI",
    plugins: [
      completionsPlugin({
        generatedPath,
        commandName,
        executable: commandName,
        includeAliases: true,
        includeGlobalFlags: true,
      }),
    ],
  });

  cli.command(daemonGroup);
  cli.command(callCommand);
  cli.command(resumeCommand);
  cli.command(searchCommand);
  cli.command(doctorCommand);
  cli.command(configCommand);

  return cli;
};
