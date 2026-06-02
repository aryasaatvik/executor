/**
 * The `create-executor` command tree.
 *
 * Invoked as `npm create executor` / `bunx create-executor`. The root command
 * scaffolds directly (it shares the `init` flags + handler), matching the
 * `npm create` convention, and also exposes `init` as an explicit subcommand so
 * `create-executor init [flags]` works too.
 *
 * @since 0.0.0
 */
import { Command } from "effect/unstable/cli";
import { initCommand, initConfig, initHandler } from "./init";

/**
 * The version string surfaced by `--version`.
 *
 * @since 0.0.0
 */
export const VERSION = "0.0.0";

/**
 * The root `create-executor` command. Running it with flags (or interactively)
 * scaffolds a host; the `init` subcommand is the explicit equivalent.
 *
 * @since 0.0.0
 */
export const cli = Command.make("create-executor", initConfig, initHandler).pipe(
  Command.withDescription("Scaffold a self-hosted Executor host (cloudflare, selfhost, or local)"),
  Command.withSubcommands([initCommand]),
);
