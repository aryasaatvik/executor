import { createCLI } from "@bunli/core";
import pkg from "../../package.json" with { type: "json" };

import callCommand from "./commands/call";
import daemonGroup from "./commands/daemon";
import doctorCommand from "./commands/doctor";
import resumeCommand from "./commands/resume";

export const createExecutorCli = async () => {
  const cli = await createCLI({
    name: "executor",
    version: pkg.version,
    description: "Local AI executor CLI",
  });

  cli.command(daemonGroup);
  cli.command(callCommand);
  cli.command(resumeCommand);
  cli.command(doctorCommand);

  return cli;
};
