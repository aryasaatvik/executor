import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ResolvedLocalWorkspaceContext } from "./config";
import {
  loadLocalControlPlaneState,
  localControlPlaneStatePath,
  writeLocalControlPlaneState,
} from "./control-plane-store";

const makeContext = (): Effect.Effect<
  ResolvedLocalWorkspaceContext,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectory({
      directory: tmpdir(),
      prefix: "executor-control-plane-store-",
    }).pipe(Effect.orDie);

    return {
      cwd: workspaceRoot,
      workspaceRoot,
      workspaceName: "executor-control-plane-store",
      configDirectory: join(workspaceRoot, ".executor"),
      projectConfigPath: join(workspaceRoot, ".executor", "executor.jsonc"),
      homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
      homeStateDirectory: join(workspaceRoot, ".executor-home-state"),
      artifactsDirectory: join(workspaceRoot, ".executor", "artifacts"),
      stateDirectory: join(workspaceRoot, ".executor", "state"),
    };
  });

describe("local-control-plane-store", () => {
  it.effect("stores secret-bearing control-plane state outside the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* makeContext();
      const expectedPath = localControlPlaneStatePath(context);
      const workspacePath = join(context.stateDirectory, "control-plane-state.json");

      yield* writeLocalControlPlaneState({
        context,
        state: {
          version: 1,
          authArtifacts: [],
          authLeases: [],
          sourceOauthClients: [],
          workspaceOauthClients: [],
          providerAuthGrants: [],
          sourceAuthSessions: [],
          secretMaterials: [],
          executions: [],
          executionInteractions: [],
          executionSteps: [],
        },
      });

      expect(expectedPath.startsWith(context.homeStateDirectory)).toBe(true);
      expect(yield* fs.exists(expectedPath)).toBe(true);
      expect(yield* fs.exists(workspacePath)).toBe(false);

      const loaded = yield* loadLocalControlPlaneState(context);
      expect(loaded.version).toBe(1);
      expect(loaded.secretMaterials).toEqual([]);

      if (process.platform !== "win32") {
        expect((yield* fs.stat(expectedPath)).mode & 0o777).toBe(0o600);
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("rejects legacy control-plane state without executionSessionId", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* makeContext();
      const path = localControlPlaneStatePath(context);

      yield* fs.makeDirectory(dirname(path), { recursive: true });
      yield* fs.writeFileString(
        path,
        `${JSON.stringify({
          version: 1,
          authArtifacts: [],
          authLeases: [],
          sourceOauthClients: [],
          workspaceOauthClients: [],
          providerAuthGrants: [],
          sourceAuthSessions: [],
          secretMaterials: [],
          executions: [
            {
              id: "exec_legacy",
              workspaceId: "ws_legacy",
              createdByAccountId: "acct_legacy",
              status: "pending",
              code: "console.log('legacy')",
              resultJson: null,
              errorText: null,
              logsJson: null,
              startedAt: null,
              completedAt: null,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          executionInteractions: [],
          executionSteps: [],
        })}\n`,
        { mode: 0o600 },
      );

      const error = yield* Effect.flip(loadLocalControlPlaneState(context));

      expect(error.message).toContain("decode control plane state");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
