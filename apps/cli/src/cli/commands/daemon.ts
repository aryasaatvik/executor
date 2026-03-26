import { defineCommand, defineGroup, option } from "@bunli/core";
import { z } from "zod";
import * as Effect from "effect/Effect";

import {
  ensureServer,
  getDefaultServerOptions,
  readDaemonPidRecord,
  readServerLogTail,
  readServerLogText,
  getServerStatus,
  printJson,
  printText,
  renderStatus,
  resolveDaemonBaseUrl,
  resolveDaemonPort,
  runCliEffect,
  startServerForeground,
  stopServer,
} from "../core";

const baseUrlOption = option(z.string().optional(), {
  description: "Override the executor daemon base URL",
});

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
      resolveDaemonBaseUrl(flags["base-url"]).pipe(
        Effect.flatMap((baseUrl) =>
          ensureServer(baseUrl).pipe(
            Effect.zipRight(getServerStatus(baseUrl)),
            Effect.flatMap((status) =>
              flags.json ? printJson(status) : printText(renderStatus(status)),
            ),
          ),
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
      resolveDaemonBaseUrl(flags["base-url"]).pipe(
        Effect.flatMap((baseUrl) =>
          stopServer(baseUrl).pipe(
            Effect.flatMap((stopped) =>
              printText(
                stopped
                  ? "Stopped local executor daemon."
                  : "Local executor daemon is not running.",
              ),
            ),
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
      resolveDaemonBaseUrl(flags["base-url"]).pipe(
        Effect.flatMap((baseUrl) =>
          stopServer(baseUrl).pipe(
            Effect.zipRight(ensureServer(baseUrl)),
            Effect.zipRight(getServerStatus(baseUrl)),
            Effect.flatMap((status) =>
              flags.json ? printJson(status) : printText(renderStatus(status)),
            ),
          ),
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
      resolveDaemonBaseUrl(flags["base-url"]).pipe(
        Effect.flatMap((baseUrl) =>
          getServerStatus(baseUrl).pipe(
            Effect.flatMap((status) =>
              flags.json ? printJson(status) : printText(renderStatus(status)),
            ),
          ),
        ),
      ),
    );
  },
});

const daemonLogsCommand = defineCommand({
  name: "logs",
  description: "Print local executor daemon logs",
  options: {
    "base-url": baseUrlOption,
    follow: option(z.coerce.boolean().default(false), {
      description: "Follow new log lines as they are written",
    }),
  },
  handler: async ({ flags, signal }) => {
    const baseUrl = await runCliEffect(resolveDaemonBaseUrl(flags["base-url"]));
    const logFile = await runCliEffect(getServerStatus(baseUrl).pipe(Effect.map((status) => status.logFile)));

    if (!flags.follow) {
      const tail = await runCliEffect(readServerLogTail(logFile));
      await runCliEffect(
        printText(tail ?? `No daemon log file found at ${logFile}. Start the daemon first.`),
      );
      return;
    }

    let firstSnapshot = true;
    let lastLength = 0;

    while (!signal.aborted) {
      const contents = await runCliEffect(readServerLogText(logFile));

      if (contents === null) {
        if (firstSnapshot) {
          await runCliEffect(printText(`Waiting for daemon log file at ${logFile}...`));
          firstSnapshot = false;
        }
      } else if (firstSnapshot) {
        const tail = await runCliEffect(readServerLogTail(logFile));
        if (tail !== null && tail.length > 0) {
          await runCliEffect(printText(tail));
        } else if (contents.length > 0) {
          await runCliEffect(printText(contents));
        }
        lastLength = contents.length;
        firstSnapshot = false;
      } else if (contents.length > lastLength) {
        const chunk = contents.slice(lastLength);
        if (chunk.length > 0) {
          process.stdout.write(chunk);
          if (!chunk.endsWith("\n")) {
            process.stdout.write("\n");
          }
        }
        lastLength = contents.length;
      } else if (contents.length < lastLength) {
        const tail = await runCliEffect(readServerLogTail(logFile));
        if (tail !== null && tail.length > 0) {
          await runCliEffect(printText(tail));
        }
        lastLength = contents.length;
      }

      await delay(1000);
    }
  },
});

const daemonDebugBootstrapCommand = defineCommand({
  name: "bootstrap",
  description: "Run the local executor server in the foreground",
  options: {
    port: option(z.coerce.number().int().positive().optional(), {
      description: "Port to bind",
    }),
  },
  handler: async ({ flags }) => {
    const port = await runCliEffect(resolveDaemonPort(flags.port));
    await runCliEffect(startServerForeground(port));
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
        logFile: options.pidFile.replace(/server\.pid$/, "server.log"),
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
    const baseUrl = await runCliEffect(resolveDaemonBaseUrl(flags["base-url"]));
    const [status, pidRecord] = await Promise.all([
      runCliEffect(getServerStatus(baseUrl)),
      runCliEffect(readDaemonPidRecord()),
    ]);

    await runCliEffect(printJson({
      baseUrl,
      status,
      pidRecord,
      defaults: getDefaultServerOptions(),
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
    daemonLogsCommand,
    daemonDebugGroup,
  ],
});

export default daemonGroup;
