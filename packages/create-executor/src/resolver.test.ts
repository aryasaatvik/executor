/**
 * Resolver tests — exercise {@link resolve} against the repo's real
 * `templates/` directory (the LOCAL source path, no network) so the scaffold
 * composition is verified end to end: which piece directories are overlaid, the
 * exact file set written, the merged npm dependency maps, and the
 * plugin-selection feature (keeping vs stripping a plugin's imports +
 * constructor entry + deps).
 *
 * These run under the Bun runtime (`bun --bun vitest run`) because the resolver
 * needs the real `FileSystem`/`Path` services from `BunServices.layer` to copy
 * piece trees and rewrite files on disk.
 */
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { resolve, type ResolvedScaffold } from "./resolver";

/**
 * The repo's `templates/` directory, resolved relative to this test file
 * (`packages/create-executor/src/resolver.test.ts` -> repo-root `templates`).
 * Used as a LOCAL `source` so the resolver reads `manifest.json` straight off
 * disk instead of fetching with giget.
 */
const TEMPLATES_DIR = new URL("../../../templates", import.meta.url).pathname;

/** Recursively list every file under `dir`, relative + sorted, dirs excluded. */
const listFiles = (
  dir: string,
): Effect.Effect<ReadonlyArray<string>, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const out: Array<string> = [];
    const walk = (
      current: string,
    ): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function* () {
        for (const entry of yield* fs.readDirectory(current)) {
          const full = path.join(current, entry);
          const stat = yield* fs.stat(full);
          if (stat.type === "Directory") yield* walk(full);
          else out.push(path.relative(dir, full));
        }
      });
    yield* walk(dir);
    return out.sort();
  });

/**
 * Resolve a scaffold into a fresh temp dir from the LOCAL templates dir, then
 * collect the resolved scaffold, the written file set, and (optionally) the text
 * of a few interesting files for content assertions.
 */
const scaffold = (opts: {
  readonly target: string;
  readonly engine?: string;
  readonly auth?: string;
  readonly plugins: ReadonlyArray<string>;
  readonly readFiles?: ReadonlyArray<string>;
}): Effect.Effect<
  {
    readonly resolved: ResolvedScaffold;
    readonly files: ReadonlyArray<string>;
    readonly contents: Record<string, string>;
  },
  unknown,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dest = yield* fs.makeTempDirectory({ prefix: "create-executor-test-" });
    const resolved = yield* resolve({
      source: TEMPLATES_DIR,
      target: opts.target,
      engine: opts.engine,
      auth: opts.auth,
      plugins: opts.plugins,
      dest,
      dryRun: false,
    });
    const files = yield* listFiles(dest);
    const contents: Record<string, string> = {};
    for (const relative of opts.readFiles ?? []) {
      contents[relative] = yield* fs.readFileString(path.join(dest, ...relative.split("/")));
    }
    return { resolved, files, contents };
  });

const ALL_CLOUDFLARE_PLUGINS = ["openapi", "mcp", "graphql"] as const;

describe("resolve (local templates)", () => {
  // (a) The proven cloudflare/dynamic-worker baseline: the default engine and
  // the default (all) plugin set must reproduce the 27-file scaffold with 21
  // dependencies / 11 devDependencies, the base -> adapter -> engine overlay
  // order, and the dynamic-worker runtime dep + wrangler.jsonc.
  it.effect("cloudflare + dynamic-worker default resolves the baseline file + dep set", () =>
    Effect.gen(function* () {
      const { resolved, files } = yield* scaffold({
        target: "cloudflare",
        plugins: ALL_CLOUDFLARE_PLUGINS,
      });

      expect(resolved.dirsApplied).toEqual([
        "cloudflare/base",
        "cloudflare/adapter",
        "cloudflare/engine-dynamic-worker",
      ]);
      expect(resolved.pluginsApplied).toEqual(["openapi", "mcp", "graphql"]);

      // 21 deps / 11 devDeps — the proven baseline.
      expect(Object.keys(resolved.dependencies)).toHaveLength(21);
      expect(Object.keys(resolved.devDependencies)).toHaveLength(11);

      // dynamic-worker is the runtime; quickjs runtime + native deps are absent.
      expect(resolved.dependencies).toHaveProperty("@executor-js/runtime-dynamic-worker");
      expect(resolved.dependencies).not.toHaveProperty("@executor-js/runtime-quickjs");
      expect(resolved.dependencies).not.toHaveProperty("quickjs-emscripten-core");

      // All three selectable plugins' deps are present (default = keep all).
      expect(resolved.dependencies).toHaveProperty("@executor-js/plugin-openapi");
      expect(resolved.dependencies).toHaveProperty("@executor-js/plugin-mcp");
      expect(resolved.dependencies).toHaveProperty("@executor-js/plugin-graphql");

      // 27-file baseline: the dynamic-worker engine ships wrangler.jsonc +
      // execution.ts and NO quickjs wasm/runtime files.
      expect(files).toHaveLength(27);
      expect(files).toContain("wrangler.jsonc");
      expect(files).toContain("src/execution.ts");
      expect(files).toContain("executor.config.ts");
      expect(files).toContain("src/plugins.ts");
      expect(files).toContain("package.json");
      expect(files).not.toContain("src/quickjs.ts");
      expect(files).not.toContain("src/quickjs-engine.wasm");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  // (b) --engine quickjs swaps the engine piece: the engine dir tail flips to
  // engine-quickjs, the quickjs runtime + native deps are added, the
  // dynamic-worker runtime dep is dropped, and the quickjs source/wasm files
  // appear.
  it.effect("cloudflare + --engine quickjs swaps the engine piece + deps", () =>
    Effect.gen(function* () {
      const { resolved, files } = yield* scaffold({
        target: "cloudflare",
        engine: "quickjs",
        plugins: ALL_CLOUDFLARE_PLUGINS,
      });

      expect(resolved.dirsApplied).toEqual([
        "cloudflare/base",
        "cloudflare/adapter",
        "cloudflare/engine-quickjs",
      ]);

      // quickjs runtime + emscripten host deps gained, dynamic-worker dropped.
      expect(resolved.dependencies).toHaveProperty("@executor-js/runtime-quickjs");
      expect(resolved.dependencies).toHaveProperty("quickjs-emscripten-core");
      expect(resolved.dependencies).toHaveProperty("@jitl/quickjs-wasmfile-release-sync");
      expect(resolved.dependencies).not.toHaveProperty("@executor-js/runtime-dynamic-worker");

      // The quickjs engine ships its own source + wasm (29 files vs 27).
      expect(files).toHaveLength(29);
      expect(files).toContain("src/quickjs.ts");
      expect(files).toContain("src/quickjs-engine.wasm");
      expect(files).toContain("wrangler.jsonc");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  // (c) The plugin-selection feature: --plugins openapi keeps only the openapi
  // plugin — its mcp/graphql imports + constructor entries are stripped from
  // src/plugins.ts and their npm deps dropped — while the default keeps all
  // three with no leftover marker comments.
  it.effect("cloudflare + --plugins openapi drops mcp + graphql imports + deps", () =>
    Effect.gen(function* () {
      const onlyOpenapi = yield* scaffold({
        target: "cloudflare",
        plugins: ["openapi"],
        readFiles: ["src/plugins.ts"],
      });

      expect(onlyOpenapi.resolved.pluginsApplied).toEqual(["openapi"]);

      // mcp + graphql deps dropped; openapi (and the always-on encrypted-secrets)
      // kept. 21 baseline deps minus 2 dropped plugins = 19.
      expect(Object.keys(onlyOpenapi.resolved.dependencies)).toHaveLength(19);
      expect(onlyOpenapi.resolved.dependencies).toHaveProperty("@executor-js/plugin-openapi");
      expect(onlyOpenapi.resolved.dependencies).not.toHaveProperty("@executor-js/plugin-mcp");
      expect(onlyOpenapi.resolved.dependencies).not.toHaveProperty("@executor-js/plugin-graphql");
      expect(onlyOpenapi.resolved.dependencies).toHaveProperty(
        "@executor-js/plugin-encrypted-secrets",
      );

      // The deselected plugins' imports + constructor entries are stripped, the
      // kept ones remain, and no marker comments leak through.
      const stripped = onlyOpenapi.contents["src/plugins.ts"];
      expect(stripped).toContain("openApiHttpPlugin");
      expect(stripped).toContain("encryptedSecretsPlugin");
      expect(stripped).not.toContain("mcpHttpPlugin");
      expect(stripped).not.toContain("graphqlHttpPlugin");
      expect(stripped).not.toContain("@executor-js/plugin-mcp");
      expect(stripped).not.toContain("@executor-js/plugin-graphql");
      expect(stripped).not.toContain("executor:plugin:");

      // The default keeps all three plugins, with their imports + constructors
      // intact and (again) no leftover marker comments.
      const allPlugins = yield* scaffold({
        target: "cloudflare",
        plugins: ALL_CLOUDFLARE_PLUGINS,
        readFiles: ["src/plugins.ts"],
      });
      expect(allPlugins.resolved.pluginsApplied).toEqual(["openapi", "mcp", "graphql"]);
      const kept = allPlugins.contents["src/plugins.ts"];
      expect(kept).toContain("openApiHttpPlugin");
      expect(kept).toContain("mcpHttpPlugin");
      expect(kept).toContain("graphqlHttpPlugin");
      expect(kept).not.toContain("executor:plugin:");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  // (d) selfhost composes base -> auth -> engine and ships the Docker + Bun
  // serve entrypoints.
  it.effect("selfhost default resolves the Docker + serve entrypoints", () =>
    Effect.gen(function* () {
      const { resolved, files } = yield* scaffold({
        target: "selfhost",
        plugins: ALL_CLOUDFLARE_PLUGINS,
      });

      expect(resolved.dirsApplied).toEqual([
        "selfhost/base",
        "selfhost/auth-better-auth",
        "selfhost/engine-quickjs",
      ]);
      expect(resolved.dependencies).toHaveProperty("@executor-js/runtime-quickjs");
      expect(resolved.dependencies).toHaveProperty("better-auth");

      expect(files).toContain("Dockerfile");
      expect(files).toContain("src/serve.ts");
      expect(files).toContain("src/auth/better-auth.ts");
      // selfhost is a Bun/Docker target, not a Worker — no wrangler.jsonc.
      expect(files).not.toContain("wrangler.jsonc");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  // (d) local composes base -> auth -> engine and ships the single-process serve
  // entrypoint (no Docker).
  it.effect("local default resolves the single-process serve entrypoint", () =>
    Effect.gen(function* () {
      const { resolved, files } = yield* scaffold({
        target: "local",
        plugins: ALL_CLOUDFLARE_PLUGINS,
      });

      expect(resolved.dirsApplied).toEqual(["local/base", "local/auth", "local/engine-quickjs"]);
      expect(resolved.dependencies).toHaveProperty("@executor-js/runtime-quickjs");

      expect(files).toContain("src/serve.ts");
      expect(files).toContain("src/main.ts");
      // local is single-process: no Docker, no Worker manifest.
      expect(files).not.toContain("Dockerfile");
      expect(files).not.toContain("wrangler.jsonc");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
