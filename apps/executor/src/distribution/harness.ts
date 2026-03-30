import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { buildDistributionPackage } from "./artifact";
import { executorAppEffectError } from "../effect-errors";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export class DistributionHarness extends Context.Tag(
  "@executor/apps/executor/distribution/DistributionHarness",
)<
  DistributionHarness,
  {
    readonly packageDir: string;
    readonly launcherPath: string;
    readonly tarballPath: string;
    readonly executorHome: string;
    readonly baseUrl: string;
    readonly writeProjectConfig: (
      contents: string,
    ) => Effect.Effect<void, Error, never>;
    readonly run: (
      args: ReadonlyArray<string>,
      options?: {
        readonly okExitCodes?: ReadonlyArray<number>;
      },
    ) => Effect.Effect<CommandResult, Error, never>;
    readonly runInstalled: (
      args: ReadonlyArray<string>,
      options?: {
        readonly okExitCodes?: ReadonlyArray<number>;
      },
    ) => Effect.Effect<CommandResult, Error, never>;
    readonly fetchText: (
      pathname: string,
    ) => Effect.Effect<{
      readonly status: number;
      readonly body: string;
      readonly contentType: string | null;
    }, Error, never>;
    readonly isReachable: () => Effect.Effect<boolean, Error, never>;
    readonly stopServer: () => Effect.Effect<void, Error, never>;
  }
>() {}

const SERVER_WAIT_TIMEOUT_MS = 5_000;
const SERVER_POLL_INTERVAL_MS = 100;

const runCommand = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly okExitCodes?: ReadonlyArray<number>;
}): Effect.Effect<CommandResult, Error, never> =>
  Effect.async((resume) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      resume(Effect.fail(error));
    });

    child.once("close", (code) => {
      const exitCode = code ?? -1;
      const result = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
      } satisfies CommandResult;
      const okExitCodes = input.okExitCodes ?? [0];

      if (okExitCodes.includes(exitCode)) {
        resume(Effect.succeed(result));
        return;
      }

      resume(Effect.fail(executorAppEffectError("distribution/harness", 
        [
          `${input.command} ${input.args.join(" ")} exited with code ${exitCode}`,
          stdout.length > 0 ? `stdout:\n${stdout.trim()}` : null,
          stderr.length > 0 ? `stderr:\n${stderr.trim()}` : null,
        ].filter((part) => part !== null).join("\n\n"),
      )));
    });

    return Effect.sync(() => {
      child.kill("SIGTERM");
    });
  });

const allocatePort = (): Effect.Effect<number, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      return await new Promise<number>((resolvePort, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            server.close(() => reject(new Error("Failed to allocate test port")));
            return;
          }

          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolvePort(address.port);
          });
        });
      });
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

const buildPackage = (packageDir: string) =>
  Effect.tryPromise({
    try: () => buildDistributionPackage({
      outputDir: packageDir,
      buildWeb: false,
    }),
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

const packPackage = (packageDir: string, outputDir: string) =>
  runCommand({
    command: "npm",
    args: ["pack", packageDir],
    cwd: outputDir,
  }).pipe(
    Effect.flatMap((result) => {
      const tarballName = result.stdout
        .split(/\s+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .at(-1);

      if (!tarballName) {
        return Effect.fail(
          executorAppEffectError("distribution/harness", `Unable to determine tarball name from npm pack output: ${result.stdout}`),
        );
      }

      return Effect.succeed(join(outputDir, tarballName));
    }),
  );

const waitForReachability = (input: {
  baseUrl: string;
  expected: boolean;
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const startedAt = Date.now();

    while (Date.now() - startedAt < SERVER_WAIT_TIMEOUT_MS) {
      const reachable = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(new URL("/", input.baseUrl));
          return response.ok;
        },
        catch: toError,
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (reachable === input.expected) {
        return;
      }

      yield* Effect.sleep(`${SERVER_POLL_INTERVAL_MS} millis`);
    }

    return yield* Effect.fail(
      new Error(
        `Timed out waiting for executor server to become ${input.expected ? "reachable" : "unreachable"} at ${input.baseUrl}`,
      ),
    );
  });

export const LocalDistributionHarnessLive = Layer.scoped(
  DistributionHarness,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempRoot = yield* Effect.acquireRelease(
      fs.makeTempDirectory({
        directory: tmpdir(),
        prefix: "executor-distribution-",
      }).pipe(Effect.mapError(toError)),
      (path) =>
        fs.remove(path, { recursive: true, force: true }).pipe(
          Effect.mapError(toError),
          Effect.orDie,
        ),
    );

    const packageDir = join(tempRoot, "package");
    const prefixDir = join(tempRoot, "prefix");
    const homeDir = join(tempRoot, "home");
    const executorHome = join(homeDir, ".executor");
    const stagedWorkspaceRoot = packageDir;
    const installedWorkspaceRoot = tempRoot;
    const baseUrl = `http://127.0.0.1:${yield* allocatePort()}`;

    yield* Effect.all([
      fs.makeDirectory(prefixDir, { recursive: true }),
      fs.makeDirectory(homeDir, { recursive: true }),
      fs.makeDirectory(executorHome, { recursive: true }),
    ]).pipe(Effect.mapError(toError));

    const artifact = yield* buildPackage(packageDir);
    const tarballPath = yield* packPackage(packageDir, tempRoot);


    const env = {
      ...process.env,
      HOME: homeDir,
      EXECUTOR_HOME: executorHome,
    } satisfies NodeJS.ProcessEnv;

    const installedEnv = {
      ...env,
      NPM_CONFIG_PREFIX: prefixDir,
      PATH: `${join(prefixDir, "bin")}:${process.env.PATH ?? ""}`,
    } satisfies NodeJS.ProcessEnv;

    yield* runCommand({
      command: "npm",
      args: ["install", "-g", tarballPath],
      cwd: tempRoot,
      env: installedEnv,
    });

    const run = (
      args: ReadonlyArray<string>,
      options?: { readonly okExitCodes?: ReadonlyArray<number> },
    ) =>
      runCommand({
        command: "node",
        args: [artifact.launcherPath, ...args],
        cwd: dirname(artifact.launcherPath),
        env,
        okExitCodes: options?.okExitCodes,
      });

    const runInstalled = (
      args: ReadonlyArray<string>,
      options?: { readonly okExitCodes?: ReadonlyArray<number> },
    ) =>
      runCommand({
        command: "executor",
        args,
        cwd: tempRoot,
        env: installedEnv,
        okExitCodes: options?.okExitCodes,
      });

    const fetchText = (pathname: string) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(new URL(pathname, baseUrl));
          return {
            status: response.status,
            body: await response.text(),
            contentType: response.headers.get("content-type"),
          };
        },
        catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
      });

    const isReachable = () =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(new URL("/", baseUrl));
          return response.ok;
        },
        catch: toError,
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

    const stopServer = () =>
      Effect.gen(function* () {
        const pidFile = join(executorHome, "run", "server.pid");
        const exists = yield* fs.exists(pidFile).pipe(Effect.mapError(toError));
        if (!exists) {
          return;
        }

        const contents = yield* fs.readFileString(pidFile).pipe(
          Effect.mapError(toError),
        );
        const parsed = JSON.parse(contents) as { pid?: number };
        const pid = parsed.pid;

        if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
          yield* Effect.try({
            try: () => process.kill(pid, "SIGTERM"),
            catch: toError,
          }).pipe(Effect.catchAll(() => Effect.void));

          const stopped = yield* waitForReachability({
            baseUrl,
            expected: false,
          }).pipe(
            Effect.as(true),
            Effect.catchAll(() => Effect.succeed(false)),
          );
          if (stopped) {
            return;
          }

          yield* Effect.try({
            try: () => process.kill(pid, "SIGKILL"),
            catch: toError,
          }).pipe(Effect.catchAll(() => Effect.void));
        }

        yield* waitForReachability({
          baseUrl,
          expected: false,
        });
      });

    const writeProjectConfig = (contents: string) =>
      Effect.forEach(
        [stagedWorkspaceRoot, installedWorkspaceRoot],
        (workspaceRoot) =>
          Effect.gen(function* () {
            const configDir = join(workspaceRoot, ".executor");
            yield* fs.makeDirectory(configDir, { recursive: true }).pipe(
              Effect.mapError(toError),
            );
            yield* fs.writeFileString(
              join(configDir, "executor.jsonc"),
              contents,
            ).pipe(Effect.mapError(toError));
          }),
        { discard: true },
      );

    return DistributionHarness.of({
      packageDir,
      launcherPath: artifact.launcherPath,
      tarballPath,
      executorHome,
      baseUrl,
      writeProjectConfig,
      run,
      runInstalled,
      fetchText,
      isReachable,
      stopServer,
    });
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);
