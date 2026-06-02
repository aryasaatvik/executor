/**
 * Cloudflare provisioning for a freshly scaffolded Executor host.
 *
 * After `init` writes the project, the host still needs its Cloudflare
 * resources wired up. This mirrors the documented setup steps for the
 * `cloudflare/base` template:
 *
 *   1. `wrangler whoami`                       — ensure the user is logged in
 *   2. `wrangler d1 create executor`           — create the D1 SQLite store,
 *                                                then patch `database_id` into
 *                                                wrangler.jsonc (replaces the
 *                                                `REPLACE_WITH_YOUR_D1_DATABASE_ID`
 *                                                placeholder)
 *   3. `wrangler r2 bucket create executor-blobs` — create the R2 offload bucket
 *   4. `wrangler secret put EXECUTOR_SECRET_KEY`   — set the at-rest secret key
 *                                                (>=16 chars; encrypts stored
 *                                                secrets)
 *   5. `wrangler types`                        — regenerate worker-configuration
 *                                                binding types
 *
 * Then it prints the manual Cloudflare Access step (set `ACCESS_TEAM_DOMAIN` +
 * `ACCESS_AUD` to your Zero Trust team domain and the Access application's AUD
 * tag) which cannot be automated from the CLI.
 *
 * All commands run inside the scaffolded project directory (`opts.dir`) via the
 * `ChildProcessSpawner` service (Bun-backed through `BunServices.layer`).
 *
 * When `opts.dryRun` is `true`, every step is PRINTED (with its cwd and the
 * wrangler.jsonc patch that would be applied) and nothing is executed and no
 * file is mutated. Real execution is gated behind `dryRun === false`.
 *
 * @since 0.0.0
 */
import {
  Console,
  Data,
  Effect,
  FileSystem,
  Path,
  type PlatformError,
  Redacted,
  Stream,
} from "effect";
import { Prompt } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/**
 * The `ChildProcessSpawner` barrel is a module namespace; the service tag is the
 * class of the same name inside it. Alias it for readable requirement types and
 * service acquisition.
 *
 * @since 0.0.0
 */
type Spawner = ChildProcessSpawner.ChildProcessSpawner;
const Spawner = ChildProcessSpawner.ChildProcessSpawner;

/**
 * The D1 database name created for the host (matches `database_name` in the
 * scaffolded wrangler.jsonc).
 *
 * @since 0.0.0
 */
const D1_DATABASE_NAME = "executor";

/**
 * The R2 bucket name created for large-value offload (matches `bucket_name` in
 * the scaffolded wrangler.jsonc).
 *
 * @since 0.0.0
 */
const R2_BUCKET_NAME = "executor-blobs";

/**
 * The secret binding that encrypts stored secrets at rest.
 *
 * @since 0.0.0
 */
const SECRET_KEY_NAME = "EXECUTOR_SECRET_KEY";

/**
 * The placeholder written into the scaffolded wrangler.jsonc that the real D1
 * `database_id` replaces.
 *
 * @since 0.0.0
 */
const D1_ID_PLACEHOLDER = "REPLACE_WITH_YOUR_D1_DATABASE_ID";

/**
 * Options for {@link provisionCloudflare}.
 *
 * - `dir`: the scaffolded project directory (cwd for every `wrangler` call).
 * - `dryRun`: when `true`, print the exact commands that WOULD run (with their
 *   cwd) and the wrangler.jsonc patch that would be applied — run nothing.
 *
 * @since 0.0.0
 */
export interface ProvisionCloudflareOptions {
  readonly dir: string;
  readonly dryRun: boolean;
}

/**
 * The user is not authenticated with Cloudflare (`wrangler whoami` reported no
 * account). They must run `wrangler login` before provisioning.
 *
 * @since 0.0.0
 */
export class CloudflareNotLoggedInError extends Data.TaggedError("CloudflareNotLoggedInError")<{
  readonly details: string;
}> {
  override get message(): string {
    return `Not logged in to Cloudflare. Run \`wrangler login\`, then re-run provisioning.\n${this.details}`;
  }
}

/**
 * A `wrangler` command exited non-zero.
 *
 * @since 0.0.0
 */
export class WranglerCommandError extends Data.TaggedError("WranglerCommandError")<{
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
  readonly cause?: PlatformError.PlatformError;
}> {
  override get message(): string {
    const base = `\`${this.command}\` failed with exit code ${this.exitCode}.`;
    const detail = this.cause !== undefined ? this.cause.message : this.output;
    return detail.length > 0 ? `${base}\n${detail}` : base;
  }
}

/**
 * The D1 `database_id` could not be extracted from `wrangler d1 create` /
 * `wrangler d1 info` output, so wrangler.jsonc cannot be patched.
 *
 * @since 0.0.0
 */
export class D1DatabaseIdParseError extends Data.TaggedError("D1DatabaseIdParseError")<{
  readonly output: string;
}> {
  override get message(): string {
    return `Could not determine the D1 database_id from wrangler output.\n${this.output}`;
  }
}

/**
 * Patching the scaffolded wrangler.jsonc failed (missing file or the
 * placeholder was already replaced / not found).
 *
 * @since 0.0.0
 */
export class WranglerConfigPatchError extends Data.TaggedError("WranglerConfigPatchError")<{
  readonly path: string;
  readonly reason: string;
  readonly cause?: PlatformError.PlatformError;
}> {
  override get message(): string {
    const detail = this.cause !== undefined ? `${this.reason}: ${this.cause.message}` : this.reason;
    return `Failed to patch ${this.path}: ${detail}`;
  }
}

/**
 * The error channel for {@link provisionCloudflare}.
 *
 * @since 0.0.0
 */
export type ProvisionCloudflareError =
  | CloudflareNotLoggedInError
  | WranglerCommandError
  | D1DatabaseIdParseError
  | WranglerConfigPatchError;

/**
 * The services {@link provisionCloudflare} requires from the environment:
 * `ChildProcessSpawner` (run wrangler), `FileSystem` + `Path` (patch
 * wrangler.jsonc), and the CLI `Prompt` environment (the interactive secret
 * prompt) — all satisfied by `BunServices.layer`.
 *
 * @since 0.0.0
 */
export type ProvisionCloudflareRequirements =
  | Spawner
  | FileSystem.FileSystem
  | Path.Path
  | Prompt.Environment;

/**
 * Render a command + args for logging (dry-run + error messages).
 */
const renderCommand = (command: string, args: ReadonlyArray<string>): string =>
  [command, ...args].join(" ");

/**
 * Run a `wrangler` invocation inside `dir`, inheriting stdio so the user sees
 * wrangler's own prompts/output, and failing loudly on a non-zero exit.
 */
const runWrangler = (
  dir: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, WranglerCommandError, Spawner> =>
  Effect.gen(function* () {
    const spawner = yield* Spawner;
    const rendered = renderCommand("wrangler", args);
    yield* Console.log(`$ ${rendered}`);
    const exit = yield* spawner
      .exitCode(
        ChildProcess.make("wrangler", args, {
          cwd: dir,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }),
      )
      .pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            new WranglerCommandError({ command: rendered, exitCode: -1, output: "", cause }),
          ),
        ),
      );
    if (exit !== 0) {
      return yield* new WranglerCommandError({ command: rendered, exitCode: exit, output: "" });
    }
  });

/**
 * Run a `wrangler` invocation inside `dir` and capture its combined output as a
 * string (used to scrape the D1 `database_id`).
 */
const captureWrangler = (
  dir: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, WranglerCommandError, Spawner> =>
  Effect.gen(function* () {
    const spawner = yield* Spawner;
    const rendered = renderCommand("wrangler", args);
    const output = yield* spawner
      .string(ChildProcess.make("wrangler", args, { cwd: dir }), { includeStderr: true })
      .pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            new WranglerCommandError({ command: rendered, exitCode: -1, output: "", cause }),
          ),
        ),
      );
    return output;
  });

/**
 * Extract a D1 `database_id` (a UUID) from wrangler output. Handles the JSONC
 * config snippet printed by `wrangler d1 create` (`"database_id": "<uuid>"` or
 * `database_id = "<uuid>"`) and the JSON of `wrangler d1 info --json`
 * (`"uuid": "<uuid>"`).
 */
const extractDatabaseId = (output: string): string | undefined => {
  const labelled = output.match(/(?:database_id|uuid)\s*[:=]\s*"([0-9a-fA-F-]{36})"/);
  if (labelled?.[1] !== undefined) {
    return labelled[1];
  }
  const bareUuid = output.match(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
  );
  return bareUuid?.[0];
};

/**
 * Resolve the D1 `database_id` by creating the database, then (if the create
 * output did not surface an id) reading it back with `wrangler d1 info --json`.
 */
const createD1AndResolveId = (
  dir: string,
): Effect.Effect<string, ProvisionCloudflareError, Spawner> =>
  Effect.gen(function* () {
    yield* Console.log(`$ wrangler d1 create ${D1_DATABASE_NAME}`);
    const createOutput = yield* captureWrangler(dir, ["d1", "create", D1_DATABASE_NAME]);
    yield* Console.log(createOutput.trim());

    const fromCreate = extractDatabaseId(createOutput);
    if (fromCreate !== undefined) {
      return fromCreate;
    }

    yield* Console.log(`$ wrangler d1 info ${D1_DATABASE_NAME} --json`);
    const infoOutput = yield* captureWrangler(dir, ["d1", "info", D1_DATABASE_NAME, "--json"]);
    const fromInfo = extractDatabaseId(infoOutput);
    if (fromInfo === undefined) {
      return yield* new D1DatabaseIdParseError({ output: `${createOutput}\n${infoOutput}` });
    }
    return fromInfo;
  });

/**
 * Patch the scaffolded wrangler.jsonc, replacing the D1 id placeholder with the
 * real `databaseId`. Fails loudly if the file is missing or the placeholder is
 * absent (so we never silently leave a broken config).
 */
const patchWranglerConfig = (
  dir: string,
  databaseId: string,
): Effect.Effect<string, WranglerConfigPatchError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const configPath = path.join(dir, "wrangler.jsonc");

    const exists = yield* fs
      .exists(configPath)
      .pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            new WranglerConfigPatchError({ path: configPath, reason: "I/O error", cause }),
          ),
        ),
      );
    if (!exists) {
      return yield* new WranglerConfigPatchError({
        path: configPath,
        reason: "file not found (did `init` run first?)",
      });
    }

    const contents = yield* fs
      .readFileString(configPath)
      .pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            new WranglerConfigPatchError({ path: configPath, reason: "I/O error", cause }),
          ),
        ),
      );
    if (!contents.includes(D1_ID_PLACEHOLDER)) {
      return yield* new WranglerConfigPatchError({
        path: configPath,
        reason: `placeholder \`${D1_ID_PLACEHOLDER}\` not found (already provisioned?)`,
      });
    }

    const patched = contents.replaceAll(D1_ID_PLACEHOLDER, databaseId);
    yield* fs
      .writeFileString(configPath, patched)
      .pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            new WranglerConfigPatchError({ path: configPath, reason: "I/O error", cause }),
          ),
        ),
      );
    return configPath;
  });

/**
 * Generate a strong random `EXECUTOR_SECRET_KEY` (>=16 chars) without prompting
 * the user — used in non-interactive provisioning.
 */
const generateSecretKey = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Pipe a value into `wrangler secret put <name>` via stdin so the secret never
 * appears on the command line. Inherits stdout/stderr for wrangler's progress.
 */
const putSecret = (
  dir: string,
  name: string,
  value: string,
): Effect.Effect<void, WranglerCommandError, Spawner> =>
  Effect.gen(function* () {
    const spawner = yield* Spawner;
    const rendered = `wrangler secret put ${name}`;
    yield* Console.log(`$ ${rendered}`);
    const handle = yield* spawner
      .spawn(
        ChildProcess.make("wrangler", ["secret", "put", name], {
          cwd: dir,
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        }),
      )
      .pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            new WranglerCommandError({ command: rendered, exitCode: -1, output: "", cause }),
          ),
        ),
      );
    yield* Stream.run(Stream.make(new TextEncoder().encode(`${value}\n`)), handle.stdin).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          new WranglerCommandError({ command: rendered, exitCode: -1, output: "", cause }),
        ),
      ),
    );
    const exit = yield* handle.exitCode.pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          new WranglerCommandError({ command: rendered, exitCode: -1, output: "", cause }),
        ),
      ),
    );
    if (exit !== 0) {
      return yield* new WranglerCommandError({ command: rendered, exitCode: exit, output: "" });
    }
  }).pipe(Effect.scoped);

/**
 * Print the manual Cloudflare Access wiring step (cannot be automated).
 */
const printAccessStep = (): Effect.Effect<void> =>
  Console.log(
    [
      "",
      "Manual step — Cloudflare Access (Zero Trust):",
      "  1. In the Cloudflare Zero Trust dashboard, create a self-hosted Access",
      "     application in front of your Worker's hostname.",
      "  2. Set wrangler.jsonc `vars.ACCESS_TEAM_DOMAIN` to your team domain",
      "     (e.g. your-team.cloudflareaccess.com).",
      "  3. Set wrangler.jsonc `vars.ACCESS_AUD` to that application's AUD tag",
      "     (replacing the REPLACE_WITH_YOUR_ACCESS_AUD placeholder).",
      "  4. Set `vars.ADMIN_EMAILS` to the admin email(s) allowed in.",
      "  Then run `npm run deploy`. For local dev without Access set",
      "  ENABLE_DEV_AUTH=true (never on a deployment that is not behind Access).",
      "",
    ].join("\n"),
  );

/**
 * Print, without executing, every command + file mutation provisioning WOULD
 * perform. Used when `dryRun` is `true`.
 */
const printDryRun = (dir: string): Effect.Effect<void, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const configPath = path.join(dir, "wrangler.jsonc");
    yield* Console.log(
      [
        `Dry run — provisioning plan (cwd: ${dir}):`,
        "",
        `  $ wrangler whoami`,
        `  $ wrangler d1 create ${D1_DATABASE_NAME}`,
        `      → patch ${configPath}: replace ${D1_ID_PLACEHOLDER} with the new database_id`,
        `  $ wrangler r2 bucket create ${R2_BUCKET_NAME}`,
        `  $ wrangler secret put ${SECRET_KEY_NAME}   (value piped via stdin)`,
        `  $ wrangler types`,
        "",
        "  Then a manual Cloudflare Access step is printed (set ACCESS_TEAM_DOMAIN +",
        "  ACCESS_AUD to your Zero Trust team domain and the Access app's AUD tag).",
        "",
        "Nothing was executed and no files were changed (dry run).",
      ].join("\n"),
    );
    yield* printAccessStep();
  });

/**
 * Ensure the user is logged in to Cloudflare via `wrangler whoami`. Captures
 * output (rather than inheriting) so we can detect the not-logged-in state.
 */
const ensureLoggedIn = (
  dir: string,
): Effect.Effect<void, CloudflareNotLoggedInError | WranglerCommandError, Spawner> =>
  Effect.gen(function* () {
    yield* Console.log("$ wrangler whoami");
    const output = yield* captureWrangler(dir, ["whoami"]);
    yield* Console.log(output.trim());
    if (/not authenticated|you are not logged in|run `?wrangler login/i.test(output)) {
      return yield* new CloudflareNotLoggedInError({ details: output.trim() });
    }
  });

/**
 * Provision the Cloudflare resources for a scaffolded Executor host.
 *
 * Runs (or, when `dryRun`, prints) the wrangler steps above in order, stopping
 * loudly on the first failure. On success the project's wrangler.jsonc has a
 * real D1 `database_id`, the R2 bucket exists, the encrypted-secrets key is set,
 * and `worker-configuration.d.ts` is regenerated. The manual Cloudflare Access
 * step is always printed at the end.
 *
 * @since 0.0.0
 */
export const provisionCloudflare = (
  opts: ProvisionCloudflareOptions,
): Effect.Effect<void, ProvisionCloudflareError, ProvisionCloudflareRequirements> => {
  if (opts.dryRun) {
    return printDryRun(opts.dir);
  }

  return Effect.gen(function* () {
    yield* Console.log(`Provisioning Cloudflare resources in ${opts.dir}...`);

    // 1. Ensure logged in.
    yield* ensureLoggedIn(opts.dir);

    // 2. Create D1 + patch wrangler.jsonc with the real database_id.
    const databaseId = yield* createD1AndResolveId(opts.dir);
    const configPath = yield* patchWranglerConfig(opts.dir, databaseId);
    yield* Console.log(`Patched ${configPath} with D1 database_id ${databaseId}.`);

    // 3. Create the R2 offload bucket.
    yield* runWrangler(opts.dir, ["r2", "bucket", "create", R2_BUCKET_NAME]);

    // 4. Set the at-rest secret key. Prompt for it interactively (falling back
    //    to a generated value if the prompt yields nothing).
    const provided = yield* Prompt.run(
      Prompt.password({
        message: `${SECRET_KEY_NAME} (>=16 chars; leave blank to auto-generate)`,
      }),
    ).pipe(Effect.orElseSucceed(() => Redacted.make("")));
    const secretValue =
      Redacted.value(provided).length >= 16 ? Redacted.value(provided) : generateSecretKey();
    if (Redacted.value(provided).length < 16) {
      yield* Console.log(`Generated a random ${SECRET_KEY_NAME}.`);
    }
    yield* putSecret(opts.dir, SECRET_KEY_NAME, secretValue);

    // 5. Regenerate worker-configuration binding types.
    yield* runWrangler(opts.dir, ["types"]);

    yield* Console.log("Cloudflare provisioning complete.");

    // 6. Print the manual Access step.
    yield* printAccessStep();
  });
};
