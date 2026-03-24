import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  loadLocalExecutorConfig,
  mergeLocalExecutorConfigs,
  readOptionalLocalExecutorConfig,
  resolveDefaultHomeConfigCandidates,
  resolveDefaultHomeStateDirectory,
  resolveLocalWorkspaceContext,
  writeHomeLocalExecutorConfig,
} from "./config";

const makeWorkspaceRoot = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.makeTempDirectory({
        directory: tmpdir(),
        prefix: "executor-local-config-",
      })
    ),
  );

describe("local-config", () => {
  it.effect("parses jsonc project config with comments and trailing commas", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* makeWorkspaceRoot();
      const configDirectory = join(workspaceRoot, ".executor");
      yield* fs.makeDirectory(configDirectory, { recursive: true });
      yield* fs.writeFileString(
        join(configDirectory, "executor.jsonc"),
        `{
  "runtime": "ses",
  "semanticSearch": {
    "provider": "openai",
    "model": "text-embedding-3-small"
  },
  // local workspace config
  "sources": {
    "github": {
      "kind": "openapi",
      "connection": {
        "endpoint": "https://api.github.com",
      },
      "binding": {
        "specUrl": "https://example.com/openapi.json",
      },
    },
  },
}
`,
      );

      const context = yield* resolveLocalWorkspaceContext({ workspaceRoot });
      const loaded = yield* loadLocalExecutorConfig(context);

      expect(loaded.config?.sources?.github?.kind).toBe("openapi");
      expect(loaded.config?.sources?.github?.connection.endpoint).toBe(
        "https://api.github.com",
      );
      expect(loaded.config?.semanticSearch?.provider).toBe("openai");
      expect(loaded.config?.semanticSearch?.model).toBe("text-embedding-3-small");
      expect(loaded.config?.runtime).toBe("ses");
      expect(context.homeStateDirectory).toMatch(/executor/i);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("reports jsonc syntax errors with line and column details", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* makeWorkspaceRoot();
      const configDirectory = join(workspaceRoot, ".executor");
      yield* fs.makeDirectory(configDirectory, { recursive: true });
      yield* fs.writeFileString(
        join(configDirectory, "executor.jsonc"),
        `{
  "sources": {
    "github": {
      "kind": "openapi"
      "connection": {
        "endpoint": "https://api.github.com"
      }
    }
  }
}
`,
      );

      const context = yield* resolveLocalWorkspaceContext({ workspaceRoot });
      const failure = yield* Effect.flip(loadLocalExecutorConfig(context));

      expect(failure.message).toContain("Invalid executor config");
      expect(failure.message).toContain("line 5, column 7");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it("uses platform-standard home config candidates", () => {
    const linuxCandidates = resolveDefaultHomeConfigCandidates({
      platform: "linux",
      homeDirectory: "/home/alice",
      env: {},
    });
    const macCandidates = resolveDefaultHomeConfigCandidates({
      platform: "darwin",
      homeDirectory: "/Users/alice",
      env: {},
    });

    expect(linuxCandidates[0]).toBe("/home/alice/.config/executor/executor.jsonc");
    expect(macCandidates[0]).toBe(
      "/Users/alice/Library/Application Support/Executor/executor.jsonc",
    );
    expect(linuxCandidates).toHaveLength(1);
    expect(macCandidates).toHaveLength(1);
  });

  it("uses platform-standard home state directories", () => {
    const linuxStateDirectory = resolveDefaultHomeStateDirectory({
      platform: "linux",
      homeDirectory: "/home/alice",
      env: {},
    });
    const macStateDirectory = resolveDefaultHomeStateDirectory({
      platform: "darwin",
      homeDirectory: "/Users/alice",
      env: {},
    });

    expect(linuxStateDirectory).toBe("/home/alice/.local/state/executor");
    expect(macStateDirectory).toBe(
      "/Users/alice/Library/Application Support/Executor/State",
    );
  });

  it("lets project config override the merged runtime", () => {
    const merged = mergeLocalExecutorConfigs(
      {
        runtime: "quickjs",
        semanticSearch: {
          provider: "local",
          model: "Qwen3-Embedding-0.6B-Q8_0",
        },
        sources: {},
      },
      {
        runtime: "deno",
        semanticSearch: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    );

    expect(merged?.runtime).toBe("deno");
    expect(merged?.semanticSearch?.provider).toBe("openai");
    expect(merged?.semanticSearch?.model).toBe("text-embedding-3-small");
  });

  it("lets project config explicitly disable semantic search", () => {
    const merged = mergeLocalExecutorConfigs(
      {
        semanticSearch: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
      {
        semanticSearch: null,
      },
    );

    expect(merged?.semanticSearch).toBeNull();
  });

  it.effect("merges top-level daemon, call, and search config domains", () =>
    Effect.gen(function* () {
      const merged = mergeLocalExecutorConfigs(
        {
          daemon: {
            baseUrl: "http://127.0.0.1:8788",
            port: 8788,
          },
          call: {
            baseUrl: "http://127.0.0.1:8788",
            noOpen: false,
          },
          search: {
            limit: 10,
            source: "mcp",
          },
        },
        {
          daemon: {
            port: 9999,
          },
          call: {
            noOpen: true,
          },
          search: {
            namespace: "github",
          },
        },
      );

      expect(merged?.daemon?.baseUrl).toBe("http://127.0.0.1:8788");
      expect(merged?.daemon?.port).toBe(9999);
      expect(merged?.call?.baseUrl).toBe("http://127.0.0.1:8788");
      expect(merged?.call?.noOpen).toBe(true);
      expect(merged?.search?.limit).toBe(10);
      expect(merged?.search?.source).toBe("mcp");
      expect(merged?.search?.namespace).toBe("github");
    }),
  );

  it.effect("writes home config files with the new top-level domains", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeConfigPath = join(
        yield* makeWorkspaceRoot(),
        ".config",
        "executor",
        "executor.jsonc",
      );

      yield* writeHomeLocalExecutorConfig({
        homeConfigPath,
        config: {
          daemon: {
            baseUrl: "http://127.0.0.1:8788",
          },
          call: {
            noOpen: true,
          },
          search: {
            limit: 25,
          },
        },
      });

      const loaded = yield* readOptionalLocalExecutorConfig(homeConfigPath);
      expect(loaded?.daemon?.baseUrl).toBe("http://127.0.0.1:8788");
      expect(loaded?.call?.noOpen).toBe(true);
      expect(loaded?.search?.limit).toBe(25);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
