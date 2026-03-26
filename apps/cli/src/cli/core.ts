import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import * as Scope from "effect/Scope";
import {
  createExecutor,
  type Executor,
  type ExecutorEffectApi,
} from "@executor/client";
import {
  ExecutionIdSchema,
  deriveLocalInstallation,
  loadLocalExecutorConfig,
  resolveLocalWorkspaceContext,
  type LocalExecutorConfig,
  type ExecutionEnvelope,
  type ExecutionInteraction,
} from "@executor/engine";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LOCAL_DATA_DIR,
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
  seedDemoMcpSourceInWorkspace,
  seedGithubOpenApiSourceInWorkspace,
} from "./dev";
import { decideInteractionHandling } from "./interaction-handling";
import {
  buildPausedExecutionOutput,
  parseInteractionPayload,
} from "./pending-interaction-output";
import {
  resolveRuntimeWebAssetsDir,
  resolveSelfCommand,
} from "./runtime-paths";
import {
  executorAppEffectError,
  localServerReachabilityTimeoutError,
  type LocalServerReachabilityTimeoutError,
} from "../effect-errors";

export const CLI_NAME = "executor";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

export const runCliEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(NodeFileSystem.layer),
    ) as Effect.Effect<A, E, never>,
  );

export const formatCliError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const loadResolvedLocalConfig = (): Effect.Effect<
  LocalExecutorConfig,
  Error,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const context = yield* resolveLocalWorkspaceContext();
    const loaded = yield* loadLocalExecutorConfig(context).pipe(
      Effect.mapError(toError),
    );
    return loaded.config ?? {};
  });

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
      const contents = yield* fs.readFileString(input.file, "utf8").pipe(
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

    return yield* Effect.fail(
      executorAppEffectError(
        "cli/core",
        "Provide code as a positional argument, use --file, or pipe code over stdin.",
      ),
    );
  });

const connectExecutor = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  Effect.tryPromise({
    try: () => createExecutor({ baseUrl }),
    catch: toError,
  });

const closeExecutor = (executor: Executor) =>
  Effect.tryPromise({
    try: () => executor.close(),
    catch: toError,
  }).pipe(Effect.catchAll(() => Effect.void));

const decodeExecutionId = Schema.decodeUnknown(ExecutionIdSchema);

export const printJson = (value: unknown) =>
  Effect.sync(() => {
    console.log(JSON.stringify(value, null, 2));
  });

export const printText = (value: string) =>
  Effect.sync(() => {
    console.log(value);
  });

const getLocalAuthedClient = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  Effect.acquireRelease(
    connectExecutor(baseUrl),
    (executor) => closeExecutor(executor),
  );

const isServerReachable = (baseUrl: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(`${baseUrl}/rpc`, { method: "HEAD" }).then((response) => response.ok),
    catch: () => false as const,
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));

const getCurrentWorkspaceInstallation = () =>
  resolveLocalWorkspaceContext().pipe(
    Effect.map((context) => deriveLocalInstallation(context)),
    Effect.mapError(toError),
  );

export const resolveDaemonBaseUrl = (
  override?: string,
): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (override && override.trim().length > 0) {
      return override;
    }

    const config = yield* loadResolvedLocalConfig();
    return config.daemon?.baseUrl ?? DEFAULT_SERVER_BASE_URL;
  });

export const resolveDaemonPort = (
  override?: number,
): Effect.Effect<number, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (typeof override === "number" && Number.isFinite(override) && override > 0) {
      return Math.trunc(override);
    }

    const config = yield* loadResolvedLocalConfig();
    const configuredPort = config.daemon?.port;
    if (
      typeof configuredPort === "number"
      && Number.isFinite(configuredPort)
      && configuredPort > 0
    ) {
      return Math.trunc(configuredPort);
    }

    return DEFAULT_SERVER_PORT;
  });

export const resolveCallCommandDefaults = (input: {
  baseUrl?: string;
  noOpen?: boolean;
}): Effect.Effect<{ baseUrl: string; noOpen: boolean }, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const config = yield* loadResolvedLocalConfig();
    return {
      baseUrl:
        (input.baseUrl && input.baseUrl.trim().length > 0 ? input.baseUrl : undefined)
        ?? config.call?.baseUrl
        ?? config.daemon?.baseUrl
        ?? DEFAULT_SERVER_BASE_URL,
      noOpen: input.noOpen ?? config.call?.noOpen ?? false,
    };
  });

export const resolveSearchCommandDefaults = (input: {
  baseUrl?: string;
  source?: string;
  namespace?: string;
  limit?: number;
}): Effect.Effect<
  {
    baseUrl: string;
    source?: string;
    namespace?: string;
    limit: number;
  },
  Error,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const config = yield* loadResolvedLocalConfig();
    const configuredLimit = input.limit ?? config.search?.limit;

    return {
      baseUrl:
        (input.baseUrl && input.baseUrl.trim().length > 0 ? input.baseUrl : undefined)
        ?? config.daemon?.baseUrl
        ?? DEFAULT_SERVER_BASE_URL,
      source: input.source ?? config.search?.source ?? undefined,
      namespace: input.namespace ?? config.search?.namespace ?? undefined,
      limit:
        typeof configuredLimit === "number" && Number.isFinite(configuredLimit) && configuredLimit > 0
          ? Math.min(100, Math.trunc(configuredLimit))
          : 10,
    };
  });

const getReachableServerInstallation = (baseUrl: string) =>
  getLocalAuthedClient(baseUrl).pipe(
    Effect.map((executor) => ({
      accountId: executor.actorId as string,
      workspaceId: executor.workspaceId as string,
    })),
    Effect.catchAll(() => Effect.succeed(null)),
  );

export const getDefaultServerOptions = (port: number = DEFAULT_SERVER_PORT) => {
  const assetsDir = resolveRuntimeWebAssetsDir();

  return {
    host: DEFAULT_SERVER_HOST,
    port,
    localDataDir: DEFAULT_LOCAL_DATA_DIR,
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

export type LocalServerPidRecord = {
  pid?: number;
  port?: number;
  host?: string;
  baseUrl?: string;
  startedAt?: number;
  logFile?: string;
};

export const readDaemonPidRecord = (): Effect.Effect<
  LocalServerPidRecord | null,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(DEFAULT_SERVER_PID_FILE, "utf8").pipe(
      Effect.catchAll(() => Effect.succeed<string | null>(null)),
    );
    if (contents === null) {
      return null;
    }

    return JSON.parse(contents) as LocalServerPidRecord;
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

const isPidRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const readServerLogText = (
  logFile: string = DEFAULT_SERVER_LOG_FILE,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(logFile, "utf8").pipe(
      Effect.catchAll(() => Effect.succeed<string | null>(null)),
    );
  });

const formatLogTail = (
  contents: string,
  maxLines: number,
  maxChars: number,
): string => {
  const lines = contents.split(/\r?\n/u).filter((line) => line.length > 0);
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
};

export const readServerLogTail = (
  logFile: string = DEFAULT_SERVER_LOG_FILE,
  maxLines: number = 40,
  maxChars: number = 6_000,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const contents = yield* readServerLogText(logFile);

    if (contents === null) {
      return null;
    }

    return formatLogTail(contents, maxLines, maxChars);
  });

const failReachabilityTimeout = (input: {
  baseUrl: string;
  expected: boolean;
  logFile?: string;
}): Effect.Effect<never, LocalServerReachabilityTimeoutError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const logFile = input.logFile ?? DEFAULT_SERVER_LOG_FILE;
    const logTail = yield* readServerLogTail(logFile);

    return yield* Effect.fail(
      localServerReachabilityTimeoutError({
        baseUrl: input.baseUrl,
        expected: input.expected,
        logFile,
        logTail,
      }),
    );
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

export type LocalServerStatus = {
  baseUrl: string;
  reachable: boolean;
  pidFile: string;
  pid: number | null;
  pidRunning: boolean;
  logFile: string;
  localDataDir: string;
  webAssetsDir: string | null;
  installation: {
    accountId: string;
    workspaceId: string;
  } | null;
  denoVersion: string | null;
};

const renderDenoSandboxDetail = (denoVersion: string | null): string =>
  denoVersion !== null
    ? `deno ${denoVersion}`
    : "deno not found";

export const getDenoVersion = (): Effect.Effect<
  string | null,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configuredDenoExecutable = process.env.DENO_BIN?.trim();
    const bundledDenoExecutable = process.env.HOME?.trim()
      ? `${process.env.HOME.trim()}/.deno/bin/deno`
      : null;
    const bundledDenoExists = bundledDenoExecutable === null
      ? false
      : yield* fs.exists(bundledDenoExecutable).pipe(
          Effect.catchAll(() => Effect.succeed(false)),
        );
    const denoExecutable = configuredDenoExecutable
      || (bundledDenoExists ? bundledDenoExecutable : null)
      || "deno";

    return yield* Effect.tryPromise({
      try: () =>
        new Promise<string | null>((resolveVersion) => {
          const child = spawn(denoExecutable, ["--version"], {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5_000,
          });

          let stdout = "";
          child.stdout?.setEncoding("utf8");
          child.stdout?.on("data", (chunk: string) => {
            stdout += chunk;
          });

          child.once("error", () => resolveVersion(null));
          child.once("close", (code) => {
            if (code !== 0) {
              resolveVersion(null);
              return;
            }

            const match = /deno\s+(\S+)/i.exec(stdout);
            resolveVersion(match ? match[1] : null);
          });
        }),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

export const getServerStatus = (
  baseUrl: string,
): Effect.Effect<LocalServerStatus, Error, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const pidRecord = yield* readDaemonPidRecord();
    const reachable = yield* isServerReachable(baseUrl);
    const installation = reachable
      ? yield* getReachableServerInstallation(baseUrl)
      : null;

    const pid = typeof pidRecord?.pid === "number" ? pidRecord.pid : null;
    const pidRunning = pid !== null ? isPidRunning(pid) : false;
    const logFile = pidRecord?.logFile ?? DEFAULT_SERVER_LOG_FILE;
    const denoVersion = yield* getDenoVersion();

    return {
      baseUrl,
      reachable,
      pidFile: DEFAULT_SERVER_PID_FILE,
      pid,
      pidRunning,
      logFile,
      localDataDir: DEFAULT_LOCAL_DATA_DIR,
      webAssetsDir: resolveRuntimeWebAssetsDir(),
      installation,
      denoVersion,
    } satisfies LocalServerStatus;
  });

export const renderStatus = (status: LocalServerStatus): string =>
  [
    `daemon: ${status.reachable ? "reachable" : "unreachable"} at ${status.baseUrl}`,
    `installation: ${
      status.installation !== null
        ? `${status.installation.workspaceId} (${status.installation.accountId})`
        : "unavailable"
    }`,
    `pid: ${status.pid ?? "none"}`,
    `pidRunning: ${status.pidRunning ? "yes" : "no"}`,
    `pidFile: ${status.pidFile}`,
    `logFile: ${status.logFile}`,
    `localDataDir: ${status.localDataDir}`,
    `webAssetsDir: ${status.webAssetsDir ?? "missing"}`,
    `workspaceId: ${status.installation?.workspaceId ?? "unavailable"}`,
    `denoSandbox: ${renderDenoSandboxDetail(status.denoVersion)}`,
  ].join("\n");

export const getDoctorReport = (baseUrl: string) =>
  getServerStatus(baseUrl).pipe(
    Effect.map((status) => {
      const checks = {
        serverReachable: {
          ok: status.reachable,
          detail: status.reachable
            ? `reachable at ${status.baseUrl}`
            : `not reachable at ${status.baseUrl}`,
        },
        pidFile: {
          ok: status.pid !== null,
          detail: status.pid !== null
            ? `pid ${status.pid}`
            : `missing pid file at ${status.pidFile}`,
        },
        process: {
          ok: status.pidRunning,
          detail: status.pidRunning
            ? `pid ${status.pid}`
            : "no live daemon process recorded",
        },
        database: {
          ok: status.localDataDir.length > 0,
          detail: status.localDataDir,
        },
        webAssets: {
          ok: status.webAssetsDir !== null,
          detail: status.webAssetsDir ?? "missing bundled web assets",
        },
        installation: {
          ok: status.installation !== null,
          detail: status.installation
            ? `workspace ${status.installation.workspaceId}`
            : "local installation unavailable",
        },
        denoSandbox: {
          ok: status.denoVersion !== null,
          detail: renderDenoSandboxDetail(status.denoVersion),
        },
      } as const;

      return {
        ok: Object.values(checks).every((check) => check.ok),
        status,
        checks,
      };
    }),
  );

export const renderDoctorReport = (report: {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail: string }>;
}): string =>
  [
    `ok: ${report.ok ? "yes" : "no"}`,
    ...Object.entries(report.checks).map(
      ([name, check]) => `${name}: ${check.ok ? "ok" : "fail"} - ${check.detail}`,
    ),
  ].join("\n");

export const stopServer = (baseUrl: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const removePidFile = fs.remove(DEFAULT_SERVER_PID_FILE, {
      force: true,
    }).pipe(Effect.ignore);
    const pidRecord = yield* readDaemonPidRecord();
    const pid = typeof pidRecord?.pid === "number" ? pidRecord.pid : null;

    if (pid === null) {
      yield* removePidFile;
      return false;
    }

    if (!isPidRunning(pid)) {
      yield* removePidFile;
      return false;
    }

    yield* Effect.sync(() => {
      process.kill(pid, "SIGTERM");
    });

    yield* waitForReachability(baseUrl, false).pipe(
      Effect.catchAll(() =>
        removePidFile.pipe(
          Effect.ignore,
          Effect.zipRight(
            Effect.fail(
              executorAppEffectError(
                "cli/core",
                `Timed out stopping local executor server pid ${pid}`,
              ),
            ),
          ),
        ),
      ),
    );

    return true;
  });

export const ensureServer = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  Effect.gen(function* () {
    const reachable = yield* isServerReachable(baseUrl);
    if (reachable) {
      const [expectedInstallation, activeInstallation] = yield* Effect.all([
        getCurrentWorkspaceInstallation(),
        getReachableServerInstallation(baseUrl),
      ]);

      if (activeInstallation?.workspaceId === expectedInstallation.workspaceId) {
        return;
      }

      const stopped = yield* stopServer(baseUrl);
      if (!stopped) {
        return yield* Effect.fail(
          executorAppEffectError(
            "cli/core",
            activeInstallation === null
              ? `Executor server at ${baseUrl} is reachable but did not report a local installation, and it could not be stopped automatically.`
              : `Executor server at ${baseUrl} is serving workspace ${activeInstallation.workspaceId}, but the current cwd expects ${expectedInstallation.workspaceId}. The daemon could not be stopped automatically.`,
          ),
        );
      }
    }

    const url = new URL(baseUrl);
    const port = Number(url.port || DEFAULT_SERVER_PORT);
    yield* startServerInBackground(port);
    yield* waitForReachability(baseUrl, true);
  });

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

const getPromptFields = (
  requestedSchema: Record<string, unknown> | undefined,
): PromptField[] => {
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

const parsePromptValue = (
  field: PromptField,
  raw: string,
):
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
  api: ExecutorEffectApi;
  executionId: ExecutionEnvelope["execution"]["id"];
  pendingInteractionId: ExecutionInteraction["id"];
}) =>
  Effect.gen(function* () {
    while (true) {
      yield* sleep(SERVER_POLL_INTERVAL_MS);

      const next = yield* input.api.executions.get(input.executionId);

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

    if (
      execution.status === "waiting_for_interaction"
      && envelope.pendingInteraction !== null
    ) {
      return;
    }

    console.log(JSON.stringify({
      id: execution.id,
      status: execution.status,
    }));
  });

const driveExecution = (input: {
  api: ExecutorEffectApi;
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
          api: input.api,
          executionId: current.execution.id,
          pendingInteractionId: pending.id,
        });
        continue;
      }

      if (handling === "url_paused" || handling === "form_paused") {
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

      current = yield* input.api.executions.resume(current.execution.id, {
        responseJson,
        interactionMode: executionInteractionMode(),
      });
    }

    return current;
  });

export const runCall = (input: {
  code?: string;
  file?: string;
  stdin?: boolean;
  baseUrl?: string;
  noOpen?: boolean;
}) =>
  Effect.gen(function* () {
    const baseUrl = input.baseUrl ?? DEFAULT_SERVER_BASE_URL;
    const resolvedCode = yield* readCode({
      code: input.code,
      file: input.file,
      stdin: input.stdin,
    });

    yield* ensureServer(baseUrl);
    const executor = yield* getLocalAuthedClient(baseUrl);
    const created = yield* executor.effect.executions.create({
      code: resolvedCode,
      interactionMode: executionInteractionMode(),
    });

    const settled = yield* driveExecution({
      api: executor.effect,
      envelope: created,
      baseUrl,
      shouldOpenUrls: !(input.noOpen ?? false),
    });

    yield* printExecution(settled);
  });

export const runResume = (input: {
  executionId: string;
  baseUrl?: string;
  noOpen?: boolean;
}) =>
  Effect.gen(function* () {
    const baseUrl = input.baseUrl ?? DEFAULT_SERVER_BASE_URL;
    yield* ensureServer(baseUrl);
    const executor = yield* getLocalAuthedClient(baseUrl);
    const decodedExecutionId = yield* decodeExecutionId(input.executionId).pipe(
      Effect.mapError((cause) => toError(cause)),
    );
    const execution = yield* executor.effect.executions.get(decodedExecutionId);

    const settled = yield* driveExecution({
      api: executor.effect,
      envelope: execution,
      baseUrl,
      shouldOpenUrls: !(input.noOpen ?? false),
    });

    yield* printExecution(settled);
  });

export const runSeedDemoMcpSource = (input: {
  baseUrl: string;
  endpoint: string;
  name: string;
  namespace: string;
}) =>
  Effect.gen(function* () {
    yield* ensureServer(input.baseUrl);
    const executor = yield* getLocalAuthedClient(input.baseUrl);
    const result = yield* seedDemoMcpSourceInWorkspace({
      api: executor.effect.sources,
      endpoint: input.endpoint,
      name: input.name,
      namespace: input.namespace,
    });

    yield* Effect.sync(() => {
      console.log(JSON.stringify(result));
    });
  });

export const runSeedGithubOpenApiSource = (input: {
  baseUrl: string;
  endpoint: string;
  specUrl: string;
  name: string;
  namespace: string;
  credentialEnvVar?: string;
}) =>
  Effect.gen(function* () {
    yield* ensureServer(input.baseUrl);
    const executor = yield* getLocalAuthedClient(input.baseUrl);
    const result = yield* seedGithubOpenApiSourceInWorkspace({
      api: executor.effect.sources,
      endpoint: input.endpoint,
      specUrl: input.specUrl,
      name: input.name,
      namespace: input.namespace,
      credentialEnvVar: input.credentialEnvVar,
    });

    yield* Effect.sync(() => {
      console.log(JSON.stringify(result));
    });
  });

export const startServerForeground = (port: number) =>
  runLocalExecutorServer(getDefaultServerOptions(port));

export const runHiddenServer = async (args: readonly string[]): Promise<boolean> => {
  if (args[0] !== "__local-server") {
    return false;
  }

  const portFlagIndex = args.findIndex((arg) => arg === "--port");
  const port = portFlagIndex >= 0 ? Number(args[portFlagIndex + 1]) : DEFAULT_SERVER_PORT;

  await runCliEffect(
    startServerForeground(
      Number.isInteger(port) && port > 0 ? port : DEFAULT_SERVER_PORT,
    ),
  );
  return true;
};
