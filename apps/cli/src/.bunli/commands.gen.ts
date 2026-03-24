// Hand-maintained metadata for Bunli completions in executor.
// Keep this aligned with the registered command tree in ../cli/app.ts.

import type { CLI, Command, GeneratedCommandMeta, RegisteredCommands, CommandOptions } from "@bunli/core";
import { createGeneratedHelpers, registerGeneratedStore } from "@bunli/core";

import callCommand from "../cli/commands/call";
import configCommand from "../cli/commands/config";
import daemonCommand from "../cli/commands/daemon";
import doctorCommand from "../cli/commands/doctor";
import resumeCommand from "../cli/commands/resume";
import searchCommand from "../cli/commands/search";

const modules = {
  daemon: daemonCommand,
  call: callCommand,
  resume: resumeCommand,
  search: searchCommand,
  doctor: doctorCommand,
  config: configCommand,
} as const satisfies Record<string, Command<any>>;

const metadata = {
  daemon: {
    name: "daemon",
    description: "Local executor daemon commands",
    commands: [
      {
        name: "start",
        description: "Ensure the local executor daemon is running",
        options: {
          "base-url": { type: "string", required: false, hasDefault: false, description: "Override the executor daemon base URL" },
          json: { type: "boolean", required: false, hasDefault: true, default: false, description: "Print status as JSON" },
        },
        path: "daemon/start",
      },
      {
        name: "stop",
        description: "Stop the local executor daemon",
        options: {
          "base-url": { type: "string", required: false, hasDefault: false, description: "Override the executor daemon base URL" },
        },
        path: "daemon/stop",
      },
      {
        name: "restart",
        description: "Restart the local executor daemon",
        options: {
          "base-url": { type: "string", required: false, hasDefault: false, description: "Override the executor daemon base URL" },
          json: { type: "boolean", required: false, hasDefault: true, default: false, description: "Print status as JSON" },
        },
        path: "daemon/restart",
      },
      {
        name: "status",
        description: "Show local executor daemon status",
        options: {
          "base-url": { type: "string", required: false, hasDefault: false, description: "Override the executor daemon base URL" },
          json: { type: "boolean", required: false, hasDefault: true, default: false, description: "Print the full status as JSON" },
        },
        path: "daemon/status",
      },
      {
        name: "logs",
        description: "Print local executor daemon logs",
        options: {
          "base-url": { type: "string", required: false, hasDefault: false, description: "Override the executor daemon base URL" },
          follow: { type: "boolean", required: false, hasDefault: true, default: false, description: "Follow new log lines as they are written" },
        },
        path: "daemon/logs",
      },
      {
        name: "debug",
        description: "Advanced daemon debugging commands",
        commands: [
          {
            name: "bootstrap",
            description: "Run the local executor server in the foreground",
            options: {
              port: { type: "number", required: false, hasDefault: false, description: "Port to bind" },
            },
            path: "daemon/debug/bootstrap",
          },
          {
            name: "paths",
            description: "Print daemon path defaults",
            path: "daemon/debug/paths",
          },
          {
            name: "info",
            description: "Print low-level daemon debug information",
            options: {
              "base-url": { type: "string", required: false, hasDefault: false, description: "Override the executor daemon base URL" },
            },
            path: "daemon/debug/info",
          },
        ],
        path: "daemon/debug",
      },
    ],
    path: "daemon",
  },
  call: {
    name: "call",
    description: "Execute code against the local executor daemon",
    options: {
      file: { type: "string", required: false, hasDefault: false, description: "Read code from a file" },
      stdin: { type: "boolean", required: false, hasDefault: true, default: false, description: "Read code from stdin" },
      "base-url": { type: "string", required: false, hasDefault: false, description: "Override the executor daemon base URL" },
      "no-open": { type: "boolean", required: false, hasDefault: false, description: "Print interaction URLs without opening a browser" },
    },
    path: "call",
  },
  resume: {
    name: "resume",
    description: "Resume a paused execution",
    options: {
      "execution-id": { type: "string", required: true, hasDefault: false, description: "Execution ID to resume" },
      "base-url": { type: "string", required: false, hasDefault: false, description: "Override the executor daemon base URL" },
      "no-open": { type: "boolean", required: false, hasDefault: false, description: "Print interaction URLs without opening a browser" },
    },
    path: "resume",
  },
  search: {
    name: "search",
    description: "Search the workspace tool catalog",
    options: {
      source: { type: "string", required: false, hasDefault: false, description: "Filter by source key" },
      namespace: { type: "string", required: false, hasDefault: false, description: "Filter by namespace" },
      limit: { type: "number", required: false, hasDefault: false, description: "Maximum results to return" },
      json: { type: "boolean", required: false, hasDefault: true, default: false, description: "Print the full result as JSON" },
      "base-url": { type: "string", required: false, hasDefault: false, description: "Override the executor daemon base URL" },
    },
    path: "search",
  },
  doctor: {
    name: "doctor",
    description: "Check local executor install and daemon health",
    options: {
      "base-url": { type: "string", required: false, hasDefault: false, description: "Override the executor daemon base URL" },
      json: { type: "boolean", required: false, hasDefault: true, default: false, description: "Print the full report as JSON" },
    },
    path: "doctor",
  },
  config: {
    name: "config",
    description: "Manage executor configuration",
    commands: [
      {
        name: "get",
        description: "Read a config path",
        options: {
          global: { type: "boolean", required: false, hasDefault: true, default: false, description: "Operate on the home config file" },
          workspace: { type: "boolean", required: false, hasDefault: true, default: false, description: "Operate on the workspace config file" },
          json: { type: "boolean", required: false, hasDefault: true, default: false, description: "Print machine-readable output" },
        },
        path: "config/get",
      },
      {
        name: "set",
        description: "Set a config path",
        options: {
          global: { type: "boolean", required: false, hasDefault: true, default: false, description: "Operate on the home config file" },
          workspace: { type: "boolean", required: false, hasDefault: true, default: false, description: "Operate on the workspace config file" },
          json: { type: "boolean", required: false, hasDefault: true, default: false, description: "Print machine-readable output" },
        },
        path: "config/set",
      },
      {
        name: "unset",
        description: "Remove a config path",
        options: {
          global: { type: "boolean", required: false, hasDefault: true, default: false, description: "Operate on the home config file" },
          workspace: { type: "boolean", required: false, hasDefault: true, default: false, description: "Operate on the workspace config file" },
          json: { type: "boolean", required: false, hasDefault: true, default: false, description: "Print machine-readable output" },
        },
        path: "config/unset",
      },
      {
        name: "list",
        description: "List config entries",
        options: {
          global: { type: "boolean", required: false, hasDefault: true, default: false, description: "Operate on the home config file" },
          workspace: { type: "boolean", required: false, hasDefault: true, default: false, description: "Operate on the workspace config file" },
          json: { type: "boolean", required: false, hasDefault: true, default: false, description: "Print machine-readable output" },
        },
        path: "config/list",
      },
    ],
    path: "config",
  },
} as const satisfies Record<string, GeneratedCommandMeta>;

export const generated = registerGeneratedStore(createGeneratedHelpers(modules, metadata));
export const commands = generated.commands;
export const commandMeta = generated.metadata;

export const cli = {
  register: (cliInstance?: CLI<any>) => {
    generated.register(cliInstance);
    return cli;
  },
  list: () => generated.list(),
  get: <Name extends keyof typeof modules>(name: Name) => generated.get(name),
  getMetadata: <Name extends keyof typeof metadata>(name: Name) => generated.getMetadata(name),
  getFlags: <Name extends keyof RegisteredCommands & string>(name: Name) =>
    generated.getFlags(name) as CommandOptions<Name>,
  getFlagsMeta: <Name extends keyof typeof modules>(name: Name) => generated.getFlagsMeta(name),
  withCLI: (cliInstance: CLI<any>) => generated.withCLI(cliInstance),
};

export default cli;

declare module "@bunli/core" {
  interface RegisteredCommands extends Record<keyof typeof modules, Command<any>> {}
}
