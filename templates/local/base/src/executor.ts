import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  Scope,
  ScopeId,
  createExecutor,
  type AnyPlugin,
  type Executor,
} from "@executor-js/sdk/core";
import { collectTables } from "@executor-js/api/server";
import { loadPluginsFromJsonc } from "@executor-js/config";

import executorConfig from "../executor.config";
import { createSqliteFumaDb } from "./db/sqlite";

// ===========================================================================
// The ONE local executor — the whole execution model for the single-user host.
//
// Local serves a SINGLE boot-built executor scoped to the working directory
// (`<basename>-<hash>`), backed by one FumaDB SQLite file under EXECUTOR_DATA_DIR
// (default ~/.executor). `oauthEndpointUrlPolicy: { allowHttp: true }` because a
// local daemon legitimately talks to http://localhost provider stubs. This file
// owns the eager async boot (open the DB, bring up the schema, build the
// executor); app.ts and main.ts consume the resolved bundle through
// `getExecutorBundle()`.
// ===========================================================================

const localNamespace = "executor_local";

interface ResolvedStorage {
  readonly dataDir: string;
  readonly sqlitePath: string;
}

const resolveStorage = (): ResolvedStorage => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    sqlitePath: join(dataDir, "data.db"),
  };
};

// Hash suffix disambiguates same-basename folders so two projects with
// identical directory names cannot collide on the same scope id.
const makeScopeId = (cwd: string): string => {
  const folder = basename(cwd) || cwd;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
};

const resolvePluginConfigPath = (scopeDir: string): string => join(scopeDir, "executor.jsonc");

// Plugins reach the host through two doors that compose:
//   - `executor.config.ts`'s static tuple
//   - `executor.jsonc#plugins` loaded at boot
// Static config wins on conflict, matching the Vite plugin.
type LocalPlugins = readonly AnyPlugin[];

const loadLocalPlugins = Effect.gen(function* () {
  const cwd = process.env.EXECUTOR_SCOPE_DIR || process.cwd();
  const staticPlugins = executorConfig.plugins();
  const dynamicPlugins =
    (yield* Effect.promise(() => loadPluginsFromJsonc({ path: resolvePluginConfigPath(cwd) }))) ??
    [];

  const staticPackageNames = new Set(
    staticPlugins.map((plugin) => plugin.packageName).filter((name): name is string => !!name),
  );
  const dedupedDynamic = dynamicPlugins.filter((plugin) => {
    if (plugin.packageName && staticPackageNames.has(plugin.packageName)) {
      console.warn(
        `[executor] plugin "${plugin.packageName}" appears in both ` +
          `executor.config.ts and executor.jsonc#plugins. The static ` +
          `entry wins; the jsonc entry is ignored.`,
      );
      return false;
    }
    return true;
  });

  return {
    cwd,
    plugins: [...staticPlugins, ...dedupedDynamic] as LocalPlugins,
  };
});

interface LocalExecutorBundle {
  readonly executor: Executor<LocalPlugins>;
  readonly plugins: LocalPlugins;
}

class LocalExecutorTag extends Context.Service<LocalExecutorTag, LocalExecutorBundle>()(
  "@executor-js/local/Executor",
) {}

export type LocalExecutor = LocalExecutorBundle["executor"];

class LocalExecutorCreateError extends Data.TaggedError("LocalExecutorCreateError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const createLocalExecutorLayer = () => {
  const storage = resolveStorage();

  return Layer.effect(LocalExecutorTag)(
    Effect.gen(function* () {
      const { cwd, plugins } = yield* loadLocalPlugins;
      const scopeId = makeScopeId(cwd);
      const tables = collectTables();

      const sqlite = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createSqliteFumaDb({
              tables,
              namespace: localNamespace,
              path: storage.sqlitePath,
            }),
          catch: (cause) =>
            new LocalExecutorCreateError({
              message:
                "Failed to open local SQLite data. Close other Executor processes and retry.",
              cause,
            }),
        }),
        (db) => Effect.promise(() => db.close()).pipe(Effect.ignore),
      );

      const scope = Scope.make({
        id: ScopeId.make(scopeId),
        name: cwd,
        createdAt: new Date(),
      });

      const executor = yield* createExecutor({
        scopes: [scope],
        db: sqlite.db,
        plugins,
        onElicitation: "accept-all",
        oauthEndpointUrlPolicy: { allowHttp: true },
        // Built-in agent-facing tools (scopes.list, secrets.list, secrets.create).
        // webBaseUrl is where the executor's web UI listens — same port as the
        // daemon API since the daemon serves both. EXECUTOR_WEB_BASE_URL overrides
        // entirely for deployments where the UI is on a different host.
        coreTools: {
          webBaseUrl:
            process.env.EXECUTOR_WEB_BASE_URL ?? `http://localhost:${process.env.PORT ?? "4788"}`,
        },
      });

      return { executor, plugins };
    }),
  );
};

export const createExecutorHandle = async () => {
  const layer = createLocalExecutorLayer();
  const runtime = ManagedRuntime.make(layer);
  const bundle = await runtime.runPromise(LocalExecutorTag.asEffect());

  return {
    executor: bundle.executor,
    plugins: bundle.plugins,
    dispose: async () => {
      await Effect.runPromise(Effect.ignore(bundle.executor.close()));
      await Effect.runPromise(
        Effect.ignore(Effect.promise(() => runtime.dispose())),
      );
    },
  };
};

export type ExecutorHandle = Awaited<ReturnType<typeof createExecutorHandle>>;

let sharedHandlePromise: ReturnType<typeof createExecutorHandle> | null = null;

const loadSharedHandle = () => {
  if (!sharedHandlePromise) {
    sharedHandlePromise = createExecutorHandle();
  }
  return sharedHandlePromise;
};

export const getExecutor = () => loadSharedHandle().then((handle) => handle.executor);
export const getExecutorBundle = () => loadSharedHandle();

export const disposeExecutor = async (): Promise<void> => {
  const currentHandlePromise = sharedHandlePromise;
  sharedHandlePromise = null;
  if (!currentHandlePromise) return;
  const handle = await currentHandlePromise;
  await handle.dispose();
};
