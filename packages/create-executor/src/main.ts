#!/usr/bin/env node
/**
 * `create-executor` process entry point.
 *
 * Wires the CLI command tree (`./cli.ts`) to the Bun runtime: `Command.run`
 * turns the tree into an `Effect` that reads argv from the `Stdio` service and
 * requires the CLI `Environment` (FileSystem, Path, Terminal, ChildProcessSpawner,
 * Stdio). `BunServices.layer` satisfies all of those, and `BunRuntime.runMain`
 * makes the effect the process main fiber with signal handling + error
 * reporting. Template fetching is owned by `giget` (its own fetch), so no
 * `HttpClient` layer is provided.
 *
 * @since 0.0.0
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { cli, VERSION } from "./cli";

Command.run(cli, { version: VERSION }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
