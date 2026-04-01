import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { FileSystem } from "@effect/platform";
import { Args, Command, Options } from "@effect/cli";
import {
  NodeFileSystem,
  NodePath,
  NodeRuntime,
} from "@effect/platform-node";
import {
  createExecutorApiEffectClient as createExecutorApiClient,
  type ExecutorApiEffectClient as ExecutorApiClient,
} from "@executor/platform-api/effect";
import { runExecutorMcpStdioServer } from "@executor/executor-mcp";
import {
  googleDiscoverySdkPlugin,
} from "@executor/plugin-google-discovery-sdk";
import {
  graphqlSdkPlugin,
} from "@executor/plugin-graphql-sdk";
import {
  keychainSecretStoreSdkPlugin,
} from "@executor/plugin-keychain-secret-store-sdk";
import {
  localSecretStoreSdkPlugin,
} from "@executor/plugin-local-secret-store-sdk";
import {
  localToolsSdkPlugin,
} from "@executor/plugin-local-tools-sdk";
import {
  mcpSdkPlugin,
} from "@executor/plugin-mcp-sdk";
import {
  openApiSdkPlugin,
} from "@executor/plugin-openapi-sdk";
import {
  sqliteSearchSdkPlugin,
} from "@executor/plugin-search-sqlite-sdk";
import {
  getExecutorInternalToolHelpLines,
  RuntimeExecutionResolverService,
} from "@executor/platform-sdk/runtime";
import type {
  ExecutorSdkPluginRegistry,
} from "@executor/platform-sdk/plugins";
import {
  createExecutorEffect,
  type ExecutorEffect as Executor,
} from "@executor/platform-sdk/effect";
import {
  createLocalExecutorBackend,
} from "@executor/platform-sdk-file";
import {
  ExecutionIdSchema,
  type ExecutionEnvelope,
  type ExecutionInteraction,
} from "@executor/platform-sdk/schema";
import type { ToolCatalog } from "@executor/codemode-core";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";

import {
  createFileGoogleDiscoveryOAuthSessionStorage,
  createFileGoogleDiscoverySourceStorage,
  createFileGraphqlSourceStorage,
  createFileMcpOAuthSessionStorage,
  createFileMcpSourceStorage,
  createFileOpenApiSourceStorage,
  createLocalExecutorServer,
  DEFAULT_SERVER_BASE_URL,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_LOG_FILE,
  DEFAULT_SERVER_PID_FILE,
  DEFAULT_SERVER_PORT,
  SERVER_POLL_INTERVAL_MS,
  SERVER_START_TIMEOUT_MS,
  runLocalExecutorServer,
} from "@executor/server";
import {
  resolveCliLocalDataDir,
  resolveRuntimeWebAssetsDir,
  resolveSelfCommand,
} from "./runtime-paths";
import {
  buildPausedExecutionOutput,
  parseInteractionPayload,
} from "./pending-interaction-output";
import { decideInteractionHandling } from "./interaction-handling";
import {
  renderMcpSessionSummary,
  renderWebSessionSummary,
} from "./session-summary";
import {
  executorAppEffectError,
  type LocalServerReachabilityTimeoutError,
  localServerReachabilityTimeoutError,
} from "../effect-errors";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));
const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const openUrlInBrowser = (url: string): Effect.Effect<void, never, never> =>
  Effect.sync(() => {
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];

    try {
      const child = spawn(cmd[0]!, cmd.slice(1), {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // Best-effort browser launch only; always leave the URL in stdout.
    }
  }).pipe(Effect.catchAll(() => Effect.void));

const promptLine = (prompt: string): Effect.Effect<string, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    catch: toError,
  });

const readStdin = (): Effect.Effect<string, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      let contents = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        contents += chunk;
      }
      return contents;
    },
    catch: toError,
  });

const readCode = (input: {
  code?: string;
  file?: string;
  stdin?: boolean;
}): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (input.code && input.code.trim().length > 0) {
      return input.code;
    }

    if (input.file && input.file.trim().length > 0) {
      const fs = yield* FileSystem.FileSystem;
      const contents = yield* fs.readFileString(input.file!, "utf8").pipe(
        Effect.mapError(toError),
      );
      if (contents.trim().length > 0) {
        return contents;
      }
    }

    const shouldReadStdin = input.stdin === true || !process.stdin.isTTY;
    if (shouldReadStdin) {
      const contents = yield* readStdin();
      if (contents.trim().length > 0) {
        return contents;
      }
    }

    return yield* executorAppEffectError("cli/main", "Provide code as a positional argument, use --file, or pipe code over stdin.");
  });

const getBootstrapClient = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  createExecutorApiClient({ baseUrl });

const decodeExecutionId = Schema.decodeUnknown(ExecutionIdSchema);
const require = createRequire(import.meta.url);
const CLI_NAME = "executor";
const CLI_LOCAL_DATA_DIR = resolveCliLocalDataDir();
const CLI_VERSION = (() => {
  const candidatePaths = [
    "../package.json",
    "../../package.json",
  ];

  for (const candidatePath of candidatePaths) {
    try {
      const metadata = require(candidatePath) as { version?: string };
      if (metadata.version && metadata.version.trim().length > 0) {
        return metadata.version;
      }
    } catch {
      // Fall through to the default version below.
    }
  }

  return "0.0.0-local";
})();
const HELP_TOKENS = ["--help", "-h", "help"] as const;

const isHelpToken = (value: string | undefined): boolean =>
  value !== undefined && HELP_TOKENS.includes(value as (typeof HELP_TOKENS)[number]);

const normalizeCliArgs = (rawArgs: readonly string[]): string[] => {
  return rawArgs[0] === "run"
    ? ["call", ...rawArgs.slice(1)]
    : [...rawArgs];
};

const getCliArgs = (): string[] => normalizeCliArgs(process.argv.slice(2));

const toEffectCliArgv = (args: readonly string[]): string[] => [
  process.execPath || CLI_NAME,
  CLI_NAME,
  ...args,
];

const buildWorkflowText = (
  namespaces: readonly string[] = [],
  pluginRegistry?: ExecutorSdkPluginRegistry,
): string =>
  [
    "Execute TypeScript in sandbox; call tools via discovery workflow.",
    ...(namespaces.length > 0
      ? [
          "Available namespaces:",
          ...namespaces.map((namespace) => `- ${namespace}`),
        ]
      : []),
    "Workflow:",
    '1) const { results, bestPath } = await tools.discover({ query: "<intent>", limit: 12 });',
    '2) const path = bestPath ?? results[0]?.path; if (!path) return "No matching tools found.";',
    "3) const details = await tools.describe.tool({ path, includeSchemas: true });",
    "4) Call selected tools.<path>(input).",
    "5) Use source plugins to inspect or add API sources.",
    ...(pluginRegistry
      ? getExecutorInternalToolHelpLines(pluginRegistry)
      : ["Use executor.* tools to inspect or manage API sources."]),
    "6) If execution pauses for interaction, resume it with `executor resume --execution-id ...`.",
    "The tools object is a lazy proxy, so Object.keys(tools) is not a useful way to discover capabilities.",
    "Do not use fetch; use tools.* only.",
  ].join("\n");

const getDefaultRunWorkflow = (pluginRegistry?: ExecutorSdkPluginRegistry) =>
  buildWorkflowText([], pluginRegistry);

const indentBlock = (value: string, prefix: string = "  "): string =>
  value
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : ""))
    .join("\n");

const formatCauseMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure instanceof Error && failure.message.length > 0) {
    return failure.message;
  }
  if (typeof failure === "string" && failure.length > 0) {
    return failure;
  }

  const defect = Option.getOrUndefined(Cause.dieOption(cause));
  if (defect instanceof Error && defect.message.length > 0) {
    return defect.message;
  }
  if (typeof defect === "string" && defect.length > 0) {
    return defect;
  }

  return Cause.pretty(cause).split("\n").find((line) => line.trim().length > 0) ?? "unknown error";
};

const formatCatalogUnavailableMessage = (cause: Cause.Cause<unknown>): string => {
  const message = formatCauseMessage(cause);
  return message === "Error: An error has occurred"
    ? "Current workspace catalog unavailable."
    : `Current workspace catalog unavailable: ${message}`;
};

const closeExecutor = (executor: Executor) =>
  Effect.tryPromise({
    try: () => executor.close(),
    catch: toError,
  }).pipe(Effect.catchAll(() => Effect.void));

const buildRunWorkflowText = (
  catalog?: ToolCatalog,
  pluginRegistry?: ExecutorSdkPluginRegistry,
): Effect.Effect<string, Error, never> => {
  if (!catalog) {
    return Effect.succeed(getDefaultRunWorkflow(pluginRegistry));
  }

  return catalog.listNamespaces({ limit: 200 }).pipe(
    Effect.map((namespaces) =>
      buildWorkflowText(
        namespaces.length > 0
          ? namespaces.map((namespace) => namespace.displayName ?? namespace.namespace)
          : ["none discovered yet"],
        pluginRegistry,
      )
    ),
    Effect.mapError(toError),
  );
};

const loadRunWorkflowText = (): Effect.Effect<string, Error, never> =>
  Effect.acquireUseRelease(
    createExecutorEffect({
      backend: createLocalExecutorBackend({
        cwd: process.cwd(),
        localDataDir: CLI_LOCAL_DATA_DIR,
      }),
      plugins: [
        localSecretStoreSdkPlugin,
        keychainSecretStoreSdkPlugin,
        localToolsSdkPlugin(),
        graphqlSdkPlugin({
          storage: createFileGraphqlSourceStorage({
            rootDir: `${CLI_LOCAL_DATA_DIR}/plugins/graphql/sources`,
          }),
        }),
        googleDiscoverySdkPlugin({
          storage: createFileGoogleDiscoverySourceStorage({
            rootDir: `${CLI_LOCAL_DATA_DIR}/plugins/google-discovery/sources`,
          }),
          oauthSessions: createFileGoogleDiscoveryOAuthSessionStorage({
            rootDir: `${CLI_LOCAL_DATA_DIR}/plugins/google-discovery/oauth-sessions`,
          }),
        }),
        mcpSdkPlugin({
          storage: createFileMcpSourceStorage({
            rootDir: `${CLI_LOCAL_DATA_DIR}/plugins/mcp/sources`,
          }),
          oauthSessions: createFileMcpOAuthSessionStorage({
            rootDir: `${CLI_LOCAL_DATA_DIR}/plugins/mcp/oauth-sessions`,
          }),
        }),
        openApiSdkPlugin({
          storage: createFileOpenApiSourceStorage({
            rootDir: `${CLI_LOCAL_DATA_DIR}/plugins/openapi/sources`,
          }),
        }),
        sqliteSearchSdkPlugin(),
      ] as const,
    }).pipe(Effect.mapError(toError)),
    (executor) =>
      Effect.gen(function* () {
        const environment = yield* Effect.gen(function* () {
          const resolveExecutionEnvironment = yield* RuntimeExecutionResolverService;
          return yield* resolveExecutionEnvironment({
            scopeId: executor.scopeId,
            actorScopeId: executor.actorScopeId,
            executionId: ExecutionIdSchema.make("exec_help"),
          });
        }).pipe(
          Effect.provide(executor.runtime.runtimeLayer),
          Effect.mapError(toError),
        );

        return yield* buildRunWorkflowText(
          environment.catalog,
          executor.runtime.pluginRegistry,
        );
      }),
    closeExecutor,
  ).pipe(
    Effect.catchAllCause((cause) =>
      Effect.succeed(
        [
          getDefaultRunWorkflow(),
          "",
          formatCatalogUnavailableMessage(cause),
        ].join("\n"),
      )
    ),
  );

const printRootHelp = (workflow: string) =>
  Effect.sync(() => {
    console.log([
      `${CLI_NAME} ${CLI_VERSION}`,
      "",
      "USAGE",
      "",
      "  executor web [--port integer]",
      "  executor mcp [--port integer] [--stdio] [--web-port integer]",
      "  executor call [code] [--file text] [--stdin] [--base-url text] [--no-open]",
      "  executor resume --execution-id text [--base-url text] [--no-open]",
      "",
      "CALL WORKFLOW",
      "",
      indentBlock(workflow),
      "",
      "COMMANDS",
      "",
      "  web",
      "    Start a foreground web session and print the local URL.",
      "  mcp",
      "    Start a foreground MCP session, or run stdio MCP with --stdio.",
      "  call",
      "    Execute code against the local executor server.",
      "  resume",
      "    Resume a paused execution.",
      "",
      "TIP",
      "",
      "  Run `executor web` for the browser UI, `executor mcp` for HTTP MCP, or `executor mcp --stdio` for local stdio MCP.",
    ].join("\n"));
  });

const printCallHelp = (workflow: string) =>
  Effect.sync(() => {
    console.log([
      "executor call",
      "",
      "USAGE",
      "",
      "  executor call [code] [--file text] [--stdin] [--base-url text] [--no-open]",
      "",
      "DESCRIPTION",
      "",
      "  Execute code against the local executor server.",
      "",
      "WORKFLOW",
      "",
      indentBlock(workflow),
      "",
      "OPTIONS",
      "",
      "  [code]",
      "    Inline code to execute.",
      "  --file text",
      "    Read code from a file.",
      "  --stdin",
      "    Read code from stdin.",
      "  --base-url text",
      "    Override the executor server base URL.",
      "  --no-open",
      "    Print interaction URLs without opening a browser.",
      "",
      "EXAMPLES",
      "",
      '  executor call \'const { results } = await tools.discover({ query: "github issues", limit: 5 }); return results.map((match) => match.path);\'',
      '  executor call \'const { results, bestPath } = await tools.discover({ query: "repo details", limit: 1 }); const path = bestPath ?? results[0]?.path; return path ? await tools.describe.tool({ path, includeSchemas: true }) : null;\'',
      "  cat script.ts | executor call --stdin",
      "  executor call --file script.ts",
      "  executor call --no-open --file script.ts",
      "  executor resume --execution-id exec_123",
    ].join("\n"));
  });

const helpOverride = (): Effect.Effect<void, Error, never> | null => {
  const args = getCliArgs();

  if (args.length === 0 || (args.length === 1 && isHelpToken(args[0]))) {
    return loadRunWorkflowText().pipe(Effect.flatMap(printRootHelp));
  }

  if (args[0] === "call" && args.length === 2 && isHelpToken(args[1])) {
    return loadRunWorkflowText().pipe(Effect.flatMap(printCallHelp));
  }

  return null;
};

const getLocalAuthedClient = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  Effect.gen(function* () {
    const bootstrapClient = yield* getBootstrapClient(baseUrl);
    const installation = yield* bootstrapClient.local.installation({});
    const client = yield* createExecutorApiClient({
      baseUrl,
    });

    return {
      installation,
      client,
    } as const;
  });

const isServerReachable = (baseUrl: string) =>
  getBootstrapClient(baseUrl).pipe(
    Effect.flatMap((client) => client.local.installation({})),
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  );

const getDefaultServerOptions = (port: number = DEFAULT_SERVER_PORT) => {
  const assetsDir = resolveRuntimeWebAssetsDir();

  return {
    host: DEFAULT_SERVER_HOST,
    port,
    localDataDir: CLI_LOCAL_DATA_DIR,
    pidFile: DEFAULT_SERVER_PID_FILE,
    ui: assetsDir ? { assetsDir } : undefined,
  };
};

const startServerInBackground = (port: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const command = resolveSelfCommand(["__local-server", "--port", String(port)]);
      yield* fs.makeDirectory(dirname(DEFAULT_SERVER_LOG_FILE), {
        recursive: true,
      }).pipe(Effect.mapError(toError));
      const logHandle = yield* fs.open(DEFAULT_SERVER_LOG_FILE, {
        flag: "a",
      }).pipe(Effect.mapError(toError));

      yield* Effect.try({
        try: () => {
          const fd = Number(logHandle.fd);
          const child = spawn(command[0]!, command.slice(1), {
            detached: true,
            stdio: ["ignore", fd, fd],
          });
          child.unref();
        },
        catch: toError,
      });
    }),
  );

const readServerLogTail = (
  logFile: string = DEFAULT_SERVER_LOG_FILE,
  maxLines: number = 40,
  maxChars: number = 6000,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(logFile, "utf8").pipe(
      Effect.catchAll(() => Effect.succeed<string | null>(null)),
    );

    if (contents === null) {
      return null;
    }

    const lines = contents.split(/\r?\n/u).filter((line) => line.length > 0);
    const tail = lines.slice(-maxLines).join("\n");
    return tail.length > maxChars ? tail.slice(-maxChars) : tail;
  });

const failReachabilityTimeout = (input: {
  baseUrl: string;
  expected: boolean;
  logFile?: string;
}): Effect.Effect<never, LocalServerReachabilityTimeoutError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const logFile = input.logFile ?? DEFAULT_SERVER_LOG_FILE;
    const logTail = yield* readServerLogTail(logFile);

    return yield* localServerReachabilityTimeoutError({
      baseUrl: input.baseUrl,
      expected: input.expected,
      logFile,
      logTail,
    });
  });

const waitForReachability = (baseUrl: string, expected: boolean) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
      const reachable = yield* isServerReachable(baseUrl);
      if (reachable === expected) {
        return;
      }
      yield* sleep(SERVER_POLL_INTERVAL_MS);
    }

    return yield* failReachabilityTimeout({ baseUrl, expected });
  });

const printText = (value: string) =>
  Effect.sync(() => {
    console.log(value);
  });

const ensureServer = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  Effect.gen(function* () {
    const reachable = yield* isServerReachable(baseUrl);
    if (reachable) {
      return {
        started: false,
      } as const;
    }

    const url = new URL(baseUrl);
    const port = Number(url.port || DEFAULT_SERVER_PORT);
    yield* startServerInBackground(port);

    yield* waitForReachability(baseUrl, true);

    return {
      started: true,
    } as const;
  });

const waitForShutdownSignal = () =>
  Effect.async<void, never>((resume) => {
    const shutdown = () => resume(Effect.void);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    return Effect.sync(() => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    });
  });

const runForegroundSession = (input: {
  kind: "web" | "mcp";
  port: number;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* createLocalExecutorServer(getDefaultServerOptions(input.port));
      const workspaceId = server.runtime.localInstallation.scopeId;
      const summary = input.kind === "web"
        ? renderWebSessionSummary({
            baseUrl: server.baseUrl,
            workspaceId,
          })
        : renderMcpSessionSummary({
            baseUrl: server.baseUrl,
            workspaceId,
          });

      yield* printText(summary);
      yield* waitForShutdownSignal();
    }),
  );

const runStdioMcpSession = (webPort?: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* createLocalExecutorServer(
        getDefaultServerOptions(webPort ?? 0),
      );
      yield* Effect.tryPromise({
        try: () => runExecutorMcpStdioServer(server.runtime),
        catch: toError,
      });
    }),
  );



const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type PromptField = {
  name: string;
  label: string;
  description?: string;
  type: string;
  required: boolean;
  enumValues?: readonly unknown[];
};

const getPromptFields = (requestedSchema: Record<string, unknown> | undefined): PromptField[] => {
  if (!requestedSchema || !isRecord(requestedSchema.properties)) {
    return [];
  }

  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  return Object.entries(requestedSchema.properties).flatMap(([name, property]) => {
    if (!isRecord(property)) {
      return [];
    }

    return [{
      name,
      label:
        typeof property.title === "string" && property.title.trim().length > 0
          ? property.title.trim()
          : name,
      description:
        typeof property.description === "string" && property.description.trim().length > 0
          ? property.description.trim()
          : undefined,
      type: typeof property.type === "string" ? property.type : "string",
      required: required.has(name),
      enumValues: Array.isArray(property.enum) ? property.enum : undefined,
    }];
  });
};

const parsePromptValue = (field: PromptField, raw: string):
  | { ok: true; value: unknown }
  | { ok: false; message: string } => {
  if (field.enumValues && field.enumValues.length > 0) {
    const normalized = field.enumValues.map((value) => String(value));
    if (!normalized.includes(raw)) {
      return {
        ok: false,
        message: `Enter one of: ${normalized.join(", ")}`,
      };
    }
  }

  if (field.type === "boolean") {
    const normalized = raw.trim().toLowerCase();
    if (["y", "yes", "true"].includes(normalized)) {
      return { ok: true, value: true };
    }
    if (["n", "no", "false"].includes(normalized)) {
      return { ok: true, value: false };
    }
    return { ok: false, message: "Enter yes or no" };
  }

  if (field.type === "number" || field.type === "integer") {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return { ok: false, message: "Enter a number" };
    }
    if (field.type === "integer" && !Number.isInteger(value)) {
      return { ok: false, message: "Enter an integer" };
    }
    return { ok: true, value };
  }

  if (field.type === "object" || field.type === "array") {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false, message: "Enter valid JSON" };
    }
  }

  return { ok: true, value: raw };
};

const promptStructuredInteraction = (parsed: {
  message: string;
  requestedSchema?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const fields = getPromptFields(parsed.requestedSchema);
    if (fields.length === 0) {
      return null as Record<string, unknown> | null;
    }

    yield* Effect.sync(() => {
      process.stdout.write(`${parsed.message}\n`);
    });

    const content: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.description) {
        yield* Effect.sync(() => {
          process.stdout.write(`${field.description}\n`);
        });
      }

      while (true) {
        const raw = yield* promptLine(
          `${field.label}${field.required ? "" : " (optional)"}: `,
        );
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          if (field.required) {
            return null;
          }
          break;
        }

        const parsedValue = parsePromptValue(field, trimmed);
        if (parsedValue.ok) {
          content[field.name] = parsedValue.value;
          break;
        }

        yield* Effect.sync(() => {
          process.stdout.write(`${parsedValue.message}\n`);
        });
      }
    }

    return content;
  });

const printUrlInteraction = (input: {
  message: string;
  url: string | null;
  shouldOpen: boolean;
}) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      process.stdout.write(`${input.message}\n${input.url ?? ""}\n`);
    });

    if (input.shouldOpen && input.url) {
      yield* openUrlInBrowser(input.url);
    }
  });

const executionInteractionMode = (): "live_form" | "detach" =>
  process.stdin.isTTY && process.stdout.isTTY ? "live_form" : "detach";

const promptInteraction = (input: {
  interaction: ExecutionInteraction;
  shouldOpenUrls: boolean;
}) =>
  Effect.gen(function* () {
    const parsed = parseInteractionPayload(input.interaction);

    if (!process.stdin.isTTY || !process.stdout.isTTY || parsed === null) {
      return null;
    }

    if (parsed.mode === "url") {
      yield* printUrlInteraction({
        message: parsed.message,
        url: parsed.url ?? null,
        shouldOpen: input.shouldOpenUrls,
      });
      return null;
    }

    const structured = yield* promptStructuredInteraction(parsed);
    if (structured !== null) {
      return JSON.stringify({
        action: "accept",
        content: structured,
      });
    }

    const line = yield* promptLine(`${parsed.message} [y/N] `);
    const normalized = line.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }
    if (normalized !== "y" && normalized !== "yes" && normalized !== "n" && normalized !== "no") {
      return null;
    }
    const accepted = normalized === "y" || normalized === "yes";

    return JSON.stringify({
      action: accepted ? "accept" : "decline",
      content: {
        approve: accepted,
      },
    });
  });

const waitForExecutionProgress = (input: {
  client: ExecutorApiClient;
  workspaceId: ExecutionEnvelope["execution"]["scopeId"];
  executionId: ExecutionEnvelope["execution"]["id"];
  pendingInteractionId: ExecutionInteraction["id"];
}) =>
  Effect.gen(function* () {
    while (true) {
      yield* sleep(SERVER_POLL_INTERVAL_MS);

      const next = yield* input.client.executions.get({
        path: {
          workspaceId: input.workspaceId,
          executionId: input.executionId,
        },
      });

      if (
        next.execution.status !== "waiting_for_interaction"
        || next.pendingInteraction === null
        || next.pendingInteraction.id !== input.pendingInteractionId
      ) {
        return next;
      }
    }
  });

const printExecution = (envelope: ExecutionEnvelope) =>
  Effect.sync(() => {
    const execution = envelope.execution;
    if (execution.status === "completed") {
      if (execution.resultJson) {
        console.log(execution.resultJson);
      } else {
        console.log("completed");
      }
      return;
    }

    if (execution.status === "failed") {
      console.error(execution.errorText ?? "Execution failed");
      process.exitCode = 1;
      return;
    }
    if (execution.status === "waiting_for_interaction" && envelope.pendingInteraction !== null) {
      return;
    }


    console.log(JSON.stringify({
      id: execution.id,
      status: execution.status,
    }));
  });

const driveExecution = (input: {
  client: ExecutorApiClient;
  workspaceId: ExecutionEnvelope["execution"]["scopeId"];
  envelope: ExecutionEnvelope;
  baseUrl: string;
  shouldOpenUrls: boolean;
}) =>
  Effect.gen(function* () {
    let current = input.envelope;

    while (current.execution.status === "waiting_for_interaction") {
      const pending = current.pendingInteraction;

      if (pending === null) {
        return current;
      }

      const parsed = parseInteractionPayload(pending);
      const handling = decideInteractionHandling({
        parsed,
        isInteractiveTerminal: process.stdin.isTTY && process.stdout.isTTY,
      });

      if (handling === "url_interactive" && parsed?.mode === "url") {
        yield* printUrlInteraction({
          message: parsed.message,
          url: parsed.url ?? null,
          shouldOpen: input.shouldOpenUrls,
        });

        current = yield* waitForExecutionProgress({
          client: input.client,
          workspaceId: input.workspaceId,
          executionId: current.execution.id,
          pendingInteractionId: pending.id,
        });
        continue;
      }

      if (handling === "url_paused") {
        if (input.shouldOpenUrls && parsed?.mode === "url" && parsed.url) {
          yield* openUrlInBrowser(parsed.url);
        }

        const paused = buildPausedExecutionOutput({
          executionId: current.execution.id,
          interaction: pending,
          baseUrl: input.baseUrl,
          shouldOpenUrls: input.shouldOpenUrls,
          cliName: CLI_NAME,
        });
        yield* Effect.sync(() => {
          console.log(JSON.stringify(paused));
          process.exitCode = 20;
        });
        return current;
      }

      if (handling === "form_paused") {
        const paused = buildPausedExecutionOutput({
          executionId: current.execution.id,
          interaction: pending,
          baseUrl: input.baseUrl,
          shouldOpenUrls: input.shouldOpenUrls,
          cliName: CLI_NAME,
        });
        yield* Effect.sync(() => {
          console.log(JSON.stringify(paused));
          process.exitCode = 20;
        });
        return current;
      }

      const responseJson = yield* promptInteraction({
        interaction: pending,
        shouldOpenUrls: input.shouldOpenUrls,
      });
      if (responseJson === null) {
        const paused = buildPausedExecutionOutput({
          executionId: current.execution.id,
          interaction: pending,
          baseUrl: input.baseUrl,
          shouldOpenUrls: input.shouldOpenUrls,
          cliName: CLI_NAME,
        });
        yield* Effect.sync(() => {
          console.log(JSON.stringify(paused));
          process.exitCode = 20;
        });
        return current;
      }

      current = yield* input.client.executions.resume({
        path: {
          workspaceId: input.workspaceId,
          executionId: current.execution.id,
        },
        payload: {
          responseJson,
          interactionMode: executionInteractionMode(),
        },
      });
    }

    return current;
  });

const serverStartCommand = Command.make(
  "start",
  {
    port: Options.integer("port").pipe(Options.withDefault(DEFAULT_SERVER_PORT)),
  },
  ({ port }) => runLocalExecutorServer(getDefaultServerOptions(port)),
).pipe(Command.withDescription("Start the local executor server"));

const serverCommand = Command.make("server").pipe(
  Command.withSubcommands([serverStartCommand] as const),
  Command.withDescription("Local server commands"),
);

const webCommand = Command.make(
  "web",
  {
    port: Options.integer("port").pipe(Options.withDefault(DEFAULT_SERVER_PORT)),
  },
  ({ port }) => runForegroundSession({ kind: "web", port }),
).pipe(Command.withDescription("Start a foreground web session and print the local URL"));

const mcpCommand = Command.make(
  "mcp",
  {
    port: Options.integer("port").pipe(Options.withDefault(DEFAULT_SERVER_PORT)),
    stdio: Options.boolean("stdio").pipe(Options.withDefault(false)),
    webPort: Options.integer("web-port").pipe(Options.optional),
  },
  ({ port, stdio, webPort }) =>
    stdio
      ? runStdioMcpSession(Option.getOrUndefined(webPort))
      : runForegroundSession({ kind: "mcp", port }),
).pipe(Command.withDescription("Start a foreground MCP session, or run stdio MCP with --stdio"));

const callCommand = Command.make(
  "call",
  {
    code: Args.text({ name: "code" }).pipe(
      Args.withDescription("Inline code to execute."),
      Args.optional,
    ),
    file: Options.text("file").pipe(Options.optional),
    stdin: Options.boolean("stdin").pipe(Options.withDefault(false)),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
    noOpen: Options.boolean("no-open").pipe(Options.withDefault(false)),
  },
  ({ code, file, stdin, baseUrl, noOpen }) =>
    Effect.gen(function* () {
      const resolvedCode = yield* readCode({
        code: Option.getOrUndefined(code),
        file: Option.getOrUndefined(file),
        stdin,
      });

      yield* ensureServer(baseUrl);
      const { installation, client } = yield* getLocalAuthedClient(baseUrl);
      const created = yield* client.executions.create({
        path: {
          workspaceId: installation.scopeId,
        },
        payload: {
          code: resolvedCode,
          interactionMode: executionInteractionMode(),
        },
      });

      const settled = yield* driveExecution({
        client,
        workspaceId: installation.scopeId,
        envelope: created,
        baseUrl,
        shouldOpenUrls: !noOpen,
      });

      yield* printExecution(settled);
    }),
).pipe(Command.withDescription("Execute code against the local executor server"));

const resumeCommand = Command.make(
  "resume",
  {
    executionId: Options.text("execution-id"),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
    noOpen: Options.boolean("no-open").pipe(Options.withDefault(false)),
  },
  ({ executionId, baseUrl, noOpen }) =>
    Effect.gen(function* () {
      yield* ensureServer(baseUrl);
      const { installation, client } = yield* getLocalAuthedClient(baseUrl);
      const decodedExecutionId = yield* decodeExecutionId(executionId).pipe(
        Effect.mapError((cause) => toError(cause)),
      );
      const execution = yield* client.executions.get({
        path: {
          workspaceId: installation.scopeId,
          executionId: decodedExecutionId,
        },
      });

      const settled = yield* driveExecution({
        client,
        workspaceId: installation.scopeId,
        envelope: execution,
        baseUrl,
        shouldOpenUrls: !noOpen,
      });

      yield* printExecution(settled);
    }),
).pipe(Command.withDescription("Resume a paused execution"));

const devCommand = Command.make("dev").pipe(
  Command.withDescription("Development helpers"),
);

const root = Command.make("executor").pipe(
  Command.withSubcommands([
    serverCommand,
    webCommand,
    mcpCommand,
    callCommand,
    resumeCommand,
    devCommand,
  ] as const),
  Command.withDescription("Executor local CLI"),
);

const runCli = Command.run(root, {
  name: CLI_NAME,
  version: CLI_VERSION,
  executable: CLI_NAME,
});

const hiddenServer = (): Effect.Effect<void, Error, never> | null => {
  const args = getCliArgs();
  if (args[0] !== "__local-server") {
    return null;
  }

  const portFlagIndex = args.findIndex((arg) => arg === "--port");
  const port = portFlagIndex >= 0 ? Number(args[portFlagIndex + 1]) : DEFAULT_SERVER_PORT;

  return runLocalExecutorServer({
    ...getDefaultServerOptions(
      Number.isInteger(port) && port > 0 ? port : DEFAULT_SERVER_PORT,
    ),
  });
};

const program = (hiddenServer()
  ?? helpOverride()
  ?? runCli(toEffectCliArgv(getCliArgs())).pipe(Effect.mapError(toError)))
  .pipe(Effect.provide(NodeFileSystem.layer))
  .pipe(Effect.provide(NodePath.layer))
  .pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        console.error(Cause.pretty(cause));
        process.exitCode = 1;
      }),
    ),
  );

// Effect CLI's environment does not fully narrow at the process boundary.
NodeRuntime.runMain(program as Effect.Effect<void, never, never>);
