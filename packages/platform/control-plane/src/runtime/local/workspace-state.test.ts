import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ResolvedLocalWorkspaceContext } from "./config";
import {
  loadLocalWorkspaceState,
  localWorkspaceStatePath,
  writeLocalWorkspaceState,
} from "./workspace-state";

const makeContext = (): Effect.Effect<
  ResolvedLocalWorkspaceContext,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectory({
      directory: tmpdir(),
      prefix: "executor-workspace-state-",
    }).pipe(Effect.orDie);

    return {
      cwd: workspaceRoot,
      workspaceRoot,
      workspaceName: "executor-workspace-state",
      configDirectory: join(workspaceRoot, ".executor"),
      projectConfigPath: join(workspaceRoot, ".executor", "executor.jsonc"),
      homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
      homeStateDirectory: join(workspaceRoot, ".executor-home-state"),
      artifactsDirectory: join(workspaceRoot, ".executor", "artifacts"),
      stateDirectory: join(workspaceRoot, ".executor", "state"),
    };
  });

describe("local-workspace-state", () => {
  it.effect("stores the workspace catalog state explicitly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* makeContext();
      const expectedPath = localWorkspaceStatePath(context);

      yield* writeLocalWorkspaceState({
        context,
        state: {
          version: 1,
          sources: {},
          catalog: {
            semanticSearchSignature: null,
          },
        },
      });

      expect(yield* fs.exists(expectedPath)).toBe(true);

      const loaded = yield* loadLocalWorkspaceState(context);
      expect(loaded.catalog.semanticSearchSignature).toBeNull();
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("rejects legacy workspace state without catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* makeContext();
      const path = localWorkspaceStatePath(context);

      yield* fs.makeDirectory(dirname(path), { recursive: true });
      yield* fs.writeFileString(
        path,
        `${JSON.stringify({
          version: 1,
          sources: {},
        })}\n`,
        { mode: 0o600 },
      );

      const error = yield* Effect.flip(loadLocalWorkspaceState(context));

      expect(error.message).toContain("Invalid local workspace state");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
