/**
 * The `init` command — scaffolds a self-hosted Executor Cloudflare host.
 *
 * Built with the Effect v4 CLI (`effect/unstable/cli`): a `Command.make` with
 * typed `Flag`s and a handler that:
 *
 *   1. resolves target / engine / auth / plugins / dir from flags, falling back
 *      to interactive {@link Prompt}s when a flag is omitted and `--yes` was not
 *      passed (with `--yes`, the documented defaults are used non-interactively),
 *   2. resolves + overlays the scaffold via {@link resolve} (giget): the
 *      templates tree's `manifest.json` selects the ordered piece list
 *      (`base -> overlays -> auth? -> engine`) for the requested target and the
 *      pieces are overlaid into `<dir>/` (engine last wins),
 *   3. rewrites the overlaid `package.json` in place with the merged deps +
 *      project name (from the dir),
 *   4. prints clear next steps driven off the target + merged env vars.
 *
 * `--dry-run` resolves + reports the plan (template pieces + merged deps)
 * without writing anything.
 *
 * @since 0.0.0
 */
import { Console, Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import { provisionCloudflare } from "./provision/cloudflare";
import { resolve } from "./resolver";

/**
 * Decode an overlaid `package.json` text into a mutable record. Parses the JSON
 * and validates the shape (an object of unknown-valued keys) in one step via
 * {@link Schema.fromJsonString}; throws the Effect Schema parse error on invalid
 * JSON. Synchronous because {@link buildPackageJson} is a pure string transform.
 */
const decodePackageJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Default templates source used when `--registry` is omitted. Either a local
 * directory containing `manifest.json`, or a GitHub `owner/repo[@ref]` slug
 * whose `templates/` subtree is fetched with giget.
 *
 * @since 0.0.0
 */
export const DEFAULT_REGISTRY = "RhysSullivan/executor";

/**
 * The host targets the CLI can scaffold. The value names a `targets.<target>`
 * entry in `templates/manifest.json`.
 *
 * @since 0.0.0
 */
export const TARGET_CHOICES = ["cloudflare", "selfhost", "local"] as const;

/**
 * Engine selections exposed by `--engine`. Friendly aliases that map onto a
 * target's `engines.choices`. Unknown engines for the selected target are
 * rejected by the resolver with the manifest's available choices.
 *
 * @since 0.0.0
 */
export const ENGINE_CHOICES = ["dynamic-worker", "quickjs"] as const;

/**
 * The default selectable plugin set kept when `--plugins` is omitted. Matches
 * every target's selectable protocol plugins, so the default scaffold keeps all
 * of them (the baseline). Passing `--plugins` selects a subset; unselected
 * plugins have their imports/constructors stripped and their deps dropped. The
 * always-on secret/core plugins (encrypted-secrets, keychain, file-secrets) are
 * not selectable and are never affected.
 *
 * @since 0.0.0
 */
export const DEFAULT_PLUGINS = ["openapi", "mcp", "graphql"] as const;

/**
 * A user-facing failure raised by the `init` handler (invalid selection,
 * missing templates source, etc.). The `message` is rendered by the runtime's
 * error reporter as the single user-visible line.
 *
 * @since 0.0.0
 */
export class InitError extends Data.TaggedError("InitError")<{
  readonly message: string;
}> {}

/**
 * `--target`: host target to scaffold. Optional; when omitted the handler
 * prompts (or uses the `cloudflare` default under `--yes`).
 *
 * @since 0.0.0
 */
export const target = Flag.choice("target", TARGET_CHOICES).pipe(
  Flag.withDescription("Host target to scaffold (default: cloudflare)"),
  Flag.optional,
);

/**
 * `--engine`: code-execution engine to compose. Optional; when omitted the
 * handler prompts (or uses the `dynamic-worker` default under `--yes`).
 *
 * @since 0.0.0
 */
export const engine = Flag.choice("engine", ENGINE_CHOICES).pipe(
  Flag.withDescription("Execution engine: dynamic-worker | quickjs (default: dynamic-worker)"),
  Flag.optional,
);

/**
 * `--auth`: auth piece to compose, for targets that declare an `auth` selection
 * (e.g. selfhost). Optional; when omitted the resolver uses the target's
 * declared default auth.
 *
 * @since 0.0.0
 */
export const auth = Flag.string("auth").pipe(
  Flag.withDescription("Auth piece for targets that support it (default: target default)"),
  Flag.optional,
);

/**
 * `--plugins`: comma-separated plugin list. Optional; when omitted the handler
 * prompts (or uses {@link DEFAULT_PLUGINS} under `--yes`).
 *
 * @since 0.0.0
 */
export const plugins = Flag.string("plugins").pipe(
  Flag.withDescription(
    "Comma-separated protocol plugins to keep: openapi,mcp,graphql (default: all)",
  ),
  Flag.optional,
);

/**
 * `--dir`: destination directory for the scaffold. Optional; when omitted the
 * handler prompts (or uses `executor-cloudflare-host` under `--yes`).
 *
 * @since 0.0.0
 */
export const dir = Flag.string("dir").pipe(
  Flag.withDescription("Directory to scaffold the host into"),
  Flag.optional,
);

/**
 * `--registry`: a local templates directory (containing `manifest.json`) OR a
 * GitHub `owner/repo[@ref]` slug whose `templates/` subtree is fetched with
 * giget. Defaults to {@link DEFAULT_REGISTRY}.
 *
 * @since 0.0.0
 */
export const registry = Flag.string("registry").pipe(
  Flag.withDescription("Templates source: local dir or GitHub owner/repo"),
  Flag.withDefault(DEFAULT_REGISTRY),
);

/**
 * `--dry-run`: resolve and print the plan without writing anything.
 *
 * @since 0.0.0
 */
export const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Resolve and print the plan without writing files"),
);

/**
 * `--provision`: after scaffolding, provision the Cloudflare resources
 * (D1, R2, secret key, types) via wrangler. Under `--dry-run` the provisioning
 * plan (wrangler commands + the wrangler.jsonc patch) is printed and nothing is
 * executed or mutated.
 *
 * @since 0.0.0
 */
export const provision = Flag.boolean("provision").pipe(
  Flag.withDescription("Provision Cloudflare resources with wrangler after scaffolding"),
);

/**
 * `--yes`: accept all defaults and skip interactive prompts.
 *
 * @since 0.0.0
 */
export const yes = Flag.boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Skip prompts; accept defaults"),
);

/**
 * The default project directory used when `--dir` is omitted under `--yes`.
 *
 * @since 0.0.0
 */
const DEFAULT_DIR = "executor-cloudflare-host";

/**
 * Resolve an optional flag to a concrete value: the flag value if present,
 * otherwise the prompt result (interactive) or the default (`--yes`).
 */
const resolveSelection = <A>(
  flag: Option.Option<A>,
  options: {
    readonly skipPrompts: boolean;
    readonly fallback: A;
    readonly prompt: Prompt.Prompt<A>;
  },
): Effect.Effect<A, never, Prompt.Environment> =>
  Option.match(flag, {
    onSome: (value) => Effect.succeed(value),
    onNone: () =>
      options.skipPrompts
        ? Effect.succeed(options.fallback)
        : // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: an interactive prompt aborted at the CLI edge (Ctrl-C / closed TTY) is an unrecoverable defect, not a domain error
          Effect.orDie(Prompt.run(options.prompt)),
  });

/**
 * Parse and validate the `--plugins` comma list, defaulting to
 * {@link DEFAULT_PLUGINS}.
 */
const parsePlugins = (raw: string): ReadonlyArray<string> =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * Build the final `package.json` text from the overlaid template plus the
 * resolved, merged dependency maps. Keeps the template's `scripts`/`type`/
 * `private`, sets the project `name` to the scaffold directory name, and
 * replaces the dependency maps with the merges from {@link resolve}.
 */
const buildPackageJson = (
  templateText: string,
  projectName: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): string => {
  const sortRecord = (record: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  const template = decodePackageJson(templateText);
  const merged = {
    ...template,
    name: projectName,
    dependencies: sortRecord(dependencies),
    devDependencies: sortRecord(devDependencies),
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
};

/**
 * The flag record shared by the `init` subcommand and the root command (so
 * `create-executor` scaffolds directly, matching the `npm create` convention).
 *
 * @since 0.0.0
 */
export const initConfig = {
  target,
  engine,
  auth,
  plugins,
  dir,
  registry,
  dryRun,
  provision,
  yes,
} as const;

/**
 * The shared scaffold handler. Resolves selections (flag → prompt → default),
 * validates them, resolves the scaffold, and writes it (or prints the plan
 * under `--dry-run`).
 *
 * @since 0.0.0
 */
export const initHandler = (config: Command.Command.Config.Infer<typeof initConfig>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skipPrompts = config.yes;

    // 1. Resolve selections (flag value, else prompt, else default).
    const selectedTarget = yield* resolveSelection(config.target, {
      skipPrompts,
      fallback: "cloudflare" as const,
      prompt: Prompt.select({
        message: "Which host do you want to scaffold?",
        choices: [
          { title: "Cloudflare Workers", value: "cloudflare" as const },
          { title: "Self-hosted (Docker / Bun)", value: "selfhost" as const },
          { title: "Local (single-process)", value: "local" as const },
        ],
      }),
    });

    // Engine selection is target-aware: only `cloudflare` exposes a real
    // engine choice (dynamic-worker | quickjs). For other targets the manifest
    // declares a single engine, so an explicit flag is honored but otherwise
    // the engine is left undefined and the resolver applies the target's
    // declared `engines.default`. This keeps `--yes` correct across targets
    // (forcing `dynamic-worker` would break selfhost/local, which only ship
    // quickjs).
    const selectedEngine = yield* Option.match(config.engine, {
      onSome: (value) => Effect.succeed<string | undefined>(value),
      onNone: () =>
        selectedTarget === "cloudflare"
          ? skipPrompts
            ? Effect.succeed<string | undefined>("dynamic-worker")
            : // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: an interactive prompt aborted at the CLI edge (Ctrl-C / closed TTY) is an unrecoverable defect, not a domain error
              Effect.orDie(
                Prompt.run(
                  Prompt.select({
                    message: "Which execution engine?",
                    choices: [
                      {
                        title: "Cloudflare Dynamic Workers (isolated, default)",
                        value: "dynamic-worker" as const,
                      },
                      { title: "QuickJS (in-process sandbox)", value: "quickjs" as const },
                    ],
                  }),
                ),
              )
          : Effect.succeed<string | undefined>(undefined),
    });

    const pluginsRaw = yield* resolveSelection(config.plugins, {
      skipPrompts,
      fallback: DEFAULT_PLUGINS.join(","),
      prompt: Prompt.text({
        message: "Plugins (comma-separated)",
        default: DEFAULT_PLUGINS.join(","),
      }),
    });

    const selectedDir = yield* resolveSelection(config.dir, {
      skipPrompts,
      fallback: DEFAULT_DIR,
      prompt: Prompt.text({ message: "Project directory", default: DEFAULT_DIR }),
    });

    const selectedPlugins = parsePlugins(pluginsRaw);
    const selectedAuth = Option.getOrUndefined(config.auth);

    // 2. Resolve the directory and the templates source.
    const targetDir = path.resolve(selectedDir);
    const projectName = path.basename(targetDir);
    const registryRoot = config.registry;

    // 3. Resolve + overlay the scaffold. The resolver fetches the templates
    //    tree once (local dir or giget), selects the ordered piece list, and
    //    overlays each piece into `targetDir` (engine last wins). Under
    //    `--dry-run` it computes the plan without writing.
    const scaffold = yield* resolve({
      source: registryRoot,
      target: selectedTarget,
      engine: selectedEngine,
      auth: selectedAuth,
      plugins: selectedPlugins,
      dest: targetDir,
      dryRun: config.dryRun,
    }).pipe(
      Effect.mapError(
        (cause: unknown) =>
          new InitError({
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: collapse the resolver's tagged ResolveError union into the single user-visible CLI line
            message: `Failed to resolve the scaffold from '${registryRoot}': ${String(cause)}`,
          }),
      ),
    );

    // The engine piece is overlaid last, so its dir tail (e.g. `engine-quickjs`)
    // names the engine that was actually applied — authoritative even when the
    // engine flag was omitted and the manifest's per-target default kicked in.
    const appliedEngine =
      selectedEngine ??
      scaffold.dirsApplied
        .at(-1)
        ?.split("/")
        .at(-1)
        ?.replace(/^engine-/, "") ??
      "default";

    yield* Console.log("");
    yield* Console.log(`Executor host scaffold (${selectedTarget} / ${appliedEngine})`);
    yield* Console.log(`  directory:  ${targetDir}`);
    yield* Console.log(`  source:     ${registryRoot}`);
    yield* Console.log(
      `  plugins:    ${
        scaffold.pluginsApplied.length > 0 ? scaffold.pluginsApplied.join(", ") : "(none)"
      }`,
    );
    yield* Console.log(`  pieces:     ${scaffold.dirsApplied.join(", ")}`);
    yield* Console.log(
      `  deps:       ${Object.keys(scaffold.dependencies).length} dependencies, ${
        Object.keys(scaffold.devDependencies).length
      } devDependencies`,
    );

    if (config.dryRun) {
      yield* Console.log("");
      yield* Console.log("Dry run — would overlay the following template pieces:");
      for (const dir of scaffold.dirsApplied) {
        yield* Console.log(`  ${dir}`);
      }
      yield* Console.log(
        `  (then rewrite ${path.join(selectedDir, "package.json")} with merged deps)`,
      );
      yield* Console.log("");
      if (config.provision && selectedTarget === "cloudflare") {
        yield* provisionCloudflare({ dir: targetDir, dryRun: true });
      }
      yield* Console.log("Dry run — no files were written.");
      return;
    }

    // 4. Rewrite the overlaid package.json in place with the merged deps +
    //    project name.
    const templateText = yield* fs.readFileString(scaffold.packageJsonTemplatePath).pipe(
      Effect.mapError(
        () =>
          new InitError({
            message: `Scaffold is missing a package.json (no piece declared packageJsonFrom output at ${scaffold.packageJsonTemplatePath}).`,
          }),
      ),
    );
    const packageJsonText = buildPackageJson(
      templateText,
      projectName,
      scaffold.dependencies,
      scaffold.devDependencies,
    );
    yield* fs.writeFileString(scaffold.packageJsonTemplatePath, packageJsonText);

    // 5. Optionally provision the Cloudflare resources via wrangler (only for
    //    the cloudflare target).
    if (config.provision && selectedTarget === "cloudflare") {
      yield* Console.log("");
      yield* provisionCloudflare({ dir: targetDir, dryRun: false }).pipe(
        Effect.mapError(
          (cause: { readonly message?: string }) =>
            new InitError({
              message: `Scaffold written, but Cloudflare provisioning failed: ${
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: surface the wrangler provisioning failure text as the single user-visible CLI line
                cause.message ?? String(cause)
              }`,
            }),
        ),
      );
    }

    // 6. Print next steps, driven off the target + the merged env vars.
    yield* Console.log("");
    yield* Console.log(`Scaffolded ${projectName} into ${targetDir}`);
    yield* Console.log("");
    yield* Console.log("Next steps:");
    yield* Console.log(`  1. cd ${selectedDir}`);
    yield* Console.log("  2. npm install");

    const envNames = Object.keys(scaffold.envVars);
    if (selectedTarget === "cloudflare") {
      yield* Console.log("  3. Provision Cloudflare resources:");
      yield* Console.log(
        "       wrangler d1 create executor        # paste the id into wrangler.jsonc",
      );
      yield* Console.log("       wrangler r2 bucket create executor-blobs");
      yield* Console.log(
        "       wrangler secret put EXECUTOR_SECRET_KEY   # >=16 chars; encrypts stored secrets",
      );
      if (envNames.length > 0) {
        yield* Console.log("  4. Configure env vars (see executor.config / wrangler.jsonc):");
        for (const name of envNames) {
          yield* Console.log(`       ${name}`);
        }
      }
      yield* Console.log("  5. npm run deploy");
    } else {
      if (envNames.length > 0) {
        yield* Console.log("  3. Configure env vars (see executor.config / .env.example):");
        for (const name of envNames) {
          yield* Console.log(`       ${name}`);
        }
      }
      yield* Console.log("  4. npm run dev");
    }
    yield* Console.log("");
  });

/**
 * The `init` subcommand: `create-executor init [flags]`.
 *
 * @since 0.0.0
 */
export const initCommand = Command.make("init", initConfig).pipe(
  Command.withDescription("Scaffold a self-hosted Executor host (cloudflare, selfhost, or local)"),
  Command.withHandler(initHandler),
);
