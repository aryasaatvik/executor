import { defineCommand, defineGroup, option } from "@bunli/core";
import { z } from "zod";
import * as Effect from "effect/Effect";

import {
  ensureServer,
  getDefaultServerOptions,
  getServerStatus,
  printJson,
  printText,
  renderStatus,
  runCliEffect,
  startServerForeground,
  stopServer,
} from "../core";

const baseUrlOption = option(z.string().default("http://127.0.0.1:8788"), {
  description: "Override the executor daemon base URL",
});

const daemonStartCommand = defineCommand({
  name: "start",
  description: "Ensure the local executor daemon is running",
  options: {
    "base-url": baseUrlOption,
    json: option(z.coerce.boolean().default(false), {
      description: "Print status as JSON",
    }),
  },
  handler: async ({ flags }) => {
    await runCliEffect(
      ensureServer(flags["base-url"]).pipe(
        Effect.zipRight(getServerStatus(flags["base-url"])),
        Effect.flatMap((status) =>
          flags.json ? printJson(status) : printText(renderStatus(status)),
        ),
      ),
    );
  },
});

const daemonStopCommand = defineCommand({
  name: "stop",
  description: "Stop the local executor daemon",
  options: {
    "base-url": baseUrlOption,
  },
  handler: async ({ flags }) => {
    await runCliEffect(
      stopServer(flags["base-url"]).pipe(
        Effect.flatMap((stopped) =>
          printText(
            stopped
              ? "Stopped local executor daemon."
              : "Local executor daemon is not running.",
          ),
        ),
      ),
    );
  },
});

const daemonRestartCommand = defineCommand({
  name: "restart",
  description: "Restart the local executor daemon",
  options: {
    "base-url": baseUrlOption,
    json: option(z.coerce.boolean().default(false), {
      description: "Print status as JSON",
    }),
  },
  handler: async ({ flags }) => {
    await runCliEffect(
      stopServer(flags["base-url"]).pipe(
        Effect.zipRight(ensureServer(flags["base-url"])),
        Effect.zipRight(getServerStatus(flags["base-url"])),
        Effect.flatMap((status) =>
          flags.json ? printJson(status) : printText(renderStatus(status)),
        ),
      ),
    );
  },
});

const daemonStatusCommand = defineCommand({
  name: "status",
  description: "Show local executor daemon status",
  options: {
    "base-url": baseUrlOption,
    json: option(z.coerce.boolean().default(false), {
      description: "Print the full status as JSON",
    }),
  },
  handler: async ({ flags }) => {
    await runCliEffect(
      getServerStatus(flags["base-url"]).pipe(
        Effect.flatMap((status) =>
          flags.json ? printJson(status) : printText(renderStatus(status)),
        ),
      ),
    );
  },
});

const daemonDebugBootstrapCommand = defineCommand({
  name: "bootstrap",
  description: "Run the local executor server in the foreground",
  options: {
    port: option(z.coerce.number().int().positive().default(getDefaultServerOptions().port), {
      description: "Port to bind",
    }),
  },
  handler: async ({ flags }) => {
    await runCliEffect(startServerForeground(flags.port));
  },
});

const daemonDebugPathsCommand = defineCommand({
  name: "paths",
  description: "Print daemon path defaults",
  handler: async () => {
    const options = getDefaultServerOptions();
    await runCliEffect(
      printJson({
        host: options.host,
        port: options.port,
        localDataDir: options.localDataDir,
        pidFile: options.pidFile,
        assetsDir: options.ui?.assetsDir ?? null,
      }),
    );
  },
});

const daemonDebugInfoCommand = defineCommand({
  name: "info",
  description: "Print low-level daemon debug information",
  options: {
    "base-url": baseUrlOption,
  },
  handler: async ({ flags }) => {
    await runCliEffect(printJson({
      baseUrl: flags["base-url"],
      options: getDefaultServerOptions(),
    }));
  },
});

const daemonDebugGroup = defineGroup({
  name: "debug",
  description: "Advanced daemon debugging commands",
  commands: [
    daemonDebugBootstrapCommand,
    daemonDebugPathsCommand,
    daemonDebugInfoCommand,
  ],
});

const daemonGroup = defineGroup({
  name: "daemon",
  description: "Local executor daemon commands",
  commands: [
    daemonStartCommand,
    daemonStopCommand,
    daemonRestartCommand,
    daemonStatusCommand,
    daemonDebugGroup,
  ],
});

export default daemonGroup;
