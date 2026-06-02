/**
 * giget-backed scaffold resolver.
 *
 * Fetches the whole templates tree once (via `giget`'s `downloadTemplate`) — or
 * reads it straight off disk for a local `source` — then composes the requested
 * scaffold by overlaying piece directories into the destination in a fixed
 * order.
 *
 * Composition order for a `{ target, engine, auth }` selection:
 *
 *   base -> ...overlays -> auth? -> engine
 *
 * Later pieces win on file collisions (so the engine's `wrangler.jsonc` /
 * engine-specific `app.ts` overwrite any base placeholder), and their npm
 * dependency maps merge into the running maps (conflicting ranges are a hard
 * error). The piece tree is copied with `FileSystem.copy` (recursive, `cp -r`),
 * which is binary-safe and needs no per-file enumeration.
 *
 * The returned `packageJsonTemplatePath` points at `<dest>/package.json` — the
 * `packageJsonFrom` piece writes a `package.json` into the destination during
 * overlay, and `init.ts` rewrites it in place with the merged deps + project
 * name.
 *
 * @since 0.0.0
 */
import { Effect, Record, Schema } from "effect";
import { FileSystem, Path } from "effect";
import { downloadTemplate } from "giget";
import { decodeManifest, type Manifest, type Piece, type Target } from "./manifest";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The templates tree or its manifest could not be obtained / parsed (local read
 * failure, giget download failure, or malformed `manifest.json`).
 *
 * @since 0.0.0
 */
export class ScaffoldSourceError extends Schema.TaggedErrorClass<ScaffoldSourceError>()(
  "ScaffoldSourceError",
  {
    source: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * A requested `target`, `engine`, or `auth` is not declared by the manifest.
 * Carries the available choices for a friendly CLI message.
 *
 * @since 0.0.0
 */
export class ScaffoldSelectionError extends Schema.TaggedErrorClass<ScaffoldSelectionError>()(
  "ScaffoldSelectionError",
  {
    kind: Schema.Literals(["target", "engine", "auth"]),
    requested: Schema.String,
    available: Schema.Array(Schema.String),
  },
) {}

/**
 * Two selected pieces declare the same npm package at incompatible version
 * ranges.
 *
 * @since 0.0.0
 */
export class ScaffoldDependencyConflictError extends Schema.TaggedErrorClass<ScaffoldDependencyConflictError>()(
  "ScaffoldDependencyConflictError",
  {
    kind: Schema.Literals(["dependencies", "devDependencies"]),
    name: Schema.String,
    first: Schema.String,
    second: Schema.String,
  },
) {}

/**
 * The error channel for {@link resolve}.
 *
 * @since 0.0.0
 */
export type ResolveError =
  | ScaffoldSourceError
  | ScaffoldSelectionError
  | ScaffoldPluginSelectionError
  | ScaffoldDependencyConflictError;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for {@link resolve}.
 *
 * - `source`: either a local directory containing `manifest.json`, or an
 *   `owner/repo[@ref]` slug whose templates are fetched with giget.
 * - `target`: host target (e.g. `cloudflare`).
 * - `engine`: engine choice; falls back to the target's declared default.
 * - `auth`: auth choice; falls back to the target's declared default (if any).
 * - `plugins`: requested selectable plugin names. The base composes ALL of the
 *   target's selectable plugins behind marker comments; unselected plugins have
 *   their marker regions stripped from `executor.config.ts` / `src/plugins.ts`
 *   and their npm deps dropped from the merged maps. An empty list keeps none of
 *   the selectable plugins; an unknown name is a hard error.
 * - `dest`: destination directory the pieces are overlaid into.
 * - `dryRun`: when `true`, the manifest is resolved and the plan is computed but
 *   no files are overlaid into `dest`.
 *
 * @since 0.0.0
 */
export interface ResolveOptions {
  readonly source: string;
  readonly target: string;
  readonly engine?: string;
  readonly auth?: string;
  readonly plugins: ReadonlyArray<string>;
  readonly dest: string;
  readonly dryRun: boolean;
}

/**
 * The resolved scaffold: which piece directories were applied, the merged npm
 * dependency maps, the merged env vars, and the path of the seeded
 * `package.json` that `init.ts` rewrites in place.
 *
 * @since 0.0.0
 */
export interface ResolvedScaffold {
  readonly dirsApplied: ReadonlyArray<string>;
  readonly pluginsApplied: ReadonlyArray<string>;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
  readonly envVars: Record<string, string>;
  readonly packageJsonTemplatePath: string;
}

// ---------------------------------------------------------------------------
// Dependency / env merging
// ---------------------------------------------------------------------------

/**
 * Merge an `name -> range` map into `into`, failing on incompatible duplicate
 * ranges. Identical ranges are idempotent.
 */
const mergeDependencies = (
  kind: "dependencies" | "devDependencies",
  into: Record<string, string>,
  incoming: Record<string, string> | undefined,
): Effect.Effect<void, ScaffoldDependencyConflictError> =>
  Effect.forEach(
    Record.toEntries(incoming ?? {}),
    ([name, range]) => {
      const existing = into[name];
      if (existing !== undefined && existing !== range) {
        return Effect.fail(
          new ScaffoldDependencyConflictError({
            kind,
            name,
            first: existing,
            second: range,
          }),
        );
      }
      into[name] = range;
      return Effect.void;
    },
    { discard: true },
  );

/** Return a new record with keys sorted (deterministic package.json ordering). */
const sortRecord = (record: Record<string, string>): Record<string, string> =>
  Record.fromEntries(Record.toEntries(record).sort(([a], [b]) => a.localeCompare(b)));

// ---------------------------------------------------------------------------
// Templates tree acquisition (local dir or giget fetch)
// ---------------------------------------------------------------------------

interface TemplatesTree {
  /** Absolute directory containing `manifest.json` + the piece dirs. */
  readonly root: string;
  readonly manifest: Manifest;
  /** Human-readable label for error messages. */
  readonly label: string;
}

/**
 * Obtain the templates tree + decoded manifest.
 *
 * - Local: if `source` is a directory containing `manifest.json`, use it as-is.
 * - Remote: treat `source` as `owner/repo[@ref]` and `downloadTemplate` the
 *   `<templatesDir>` subtree into a temp dir ONCE (one network round-trip,
 *   binary-safe), then read `manifest.json` from the extracted tree.
 *
 * The remote `templatesDir`/`ref` come from the requested slug — `templatesDir`
 * defaults to `templates` and `ref` to `main` until the manifest itself is read
 * (the manifest's `source` is authoritative for printing, but the giget spec
 * must be formed before the manifest is available).
 */
const obtainTree = (
  source: string,
): Effect.Effect<TemplatesTree, ScaffoldSourceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const localManifestPath = path.join(path.resolve(source), "manifest.json");
    const isLocal = yield* fs.exists(localManifestPath).pipe(Effect.orElseSucceed(() => false));

    if (isLocal) {
      const root = path.resolve(source);
      const manifest = yield* readManifestAt(fs, path, root);
      return { root, manifest, label: root } satisfies TemplatesTree;
    }

    // Remote owner/repo[@ref]. Defaults match the canonical templates layout.
    const [slug, refRaw] = source.split("@");
    const ref = refRaw && refRaw.length > 0 ? refRaw : "main";
    const templatesDir = "templates";
    const giget = `gh:${slug}/${templatesDir}#${ref}`;

    const tmp = yield* fs.makeTempDirectory({ prefix: "create-executor-" }).pipe(
      Effect.mapError(
        (cause) =>
          new ScaffoldSourceError({
            source,
            message: "failed to create temp directory for template download",
            cause,
          }),
      ),
    );

    yield* Effect.tryPromise({
      try: () => downloadTemplate(giget, { dir: tmp, force: true }),
      catch: (cause) =>
        new ScaffoldSourceError({
          source: giget,
          message: `failed to download templates from '${slug}@${ref}'`,
          cause,
        }),
    });

    const manifest = yield* readManifestAt(fs, path, tmp);
    return { root: tmp, manifest, label: `${slug}@${ref}` } satisfies TemplatesTree;
  });

/** Read + decode `manifest.json` from a templates root directory. */
const readManifestAt = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<Manifest, ScaffoldSourceError> =>
  Effect.gen(function* () {
    const manifestPath = path.join(root, "manifest.json");
    const raw = yield* fs.readFileString(manifestPath).pipe(
      Effect.mapError(
        (cause) =>
          new ScaffoldSourceError({
            source: manifestPath,
            message: "failed to read manifest.json",
            cause,
          }),
      ),
    );
    return yield* decodeManifest(raw).pipe(
      Effect.mapError(
        (error) =>
          new ScaffoldSourceError({
            source: manifestPath,
            message: `malformed manifest.json: ${error.issue.toString()}`,
          }),
      ),
    );
  });

// ---------------------------------------------------------------------------
// Piece selection
// ---------------------------------------------------------------------------

/**
 * Resolve the ordered piece list for `{ target, engine, auth }`:
 * `[base, ...overlays, auth?, engine]`. The engine is applied last so it wins on
 * file collisions. Unknown target / engine / auth -> {@link ScaffoldSelectionError}.
 */
const selectPieces = (
  manifest: Manifest,
  opts: { readonly target: string; readonly engine?: string; readonly auth?: string },
): Effect.Effect<
  {
    readonly target: Target;
    readonly pieces: ReadonlyArray<Piece>;
    readonly packageJsonFrom: string;
  },
  ScaffoldSelectionError
> =>
  Effect.gen(function* () {
    const target = manifest.targets[opts.target];
    if (target === undefined) {
      return yield* new ScaffoldSelectionError({
        kind: "target",
        requested: opts.target,
        available: Object.keys(manifest.targets).sort(),
      });
    }

    const pieces: Array<Piece> = [target.base, ...(target.overlays ?? [])];

    if (target.auth !== undefined) {
      const authKey = opts.auth ?? target.auth.default;
      const authPiece = target.auth.choices[authKey];
      if (authPiece === undefined) {
        return yield* new ScaffoldSelectionError({
          kind: "auth",
          requested: authKey,
          available: Object.keys(target.auth.choices).sort(),
        });
      }
      pieces.push(authPiece);
    }

    const engineKey = opts.engine ?? target.engines.default;
    const enginePiece = target.engines.choices[engineKey];
    if (enginePiece === undefined) {
      return yield* new ScaffoldSelectionError({
        kind: "engine",
        requested: engineKey,
        available: Object.keys(target.engines.choices).sort(),
      });
    }
    pieces.push(enginePiece);

    return { target, pieces, packageJsonFrom: target.packageJsonFrom };
  });

// ---------------------------------------------------------------------------
// Plugin selection + marker stripping
// ---------------------------------------------------------------------------

/**
 * A requested plugin is not in the target's selectable plugin set (the manifest
 * `plugins` list / `pluginRegistry`). Carries the available plugins for a
 * friendly CLI message.
 *
 * @since 0.0.0
 */
export class ScaffoldPluginSelectionError extends Schema.TaggedErrorClass<ScaffoldPluginSelectionError>()(
  "ScaffoldPluginSelectionError",
  {
    requested: Schema.String,
    available: Schema.Array(Schema.String),
  },
) {}

/**
 * Template files whose marker regions are stripped when a plugin is deselected.
 * Relative to the scaffold destination root. Files that do not exist for a given
 * target (e.g. `local` ships no `src/plugins.ts`) are skipped silently, and a
 * file with no markers (e.g. selfhost's re-exporting `src/plugins.ts`) is left
 * untouched.
 */
const PLUGIN_MARKED_FILES = ["executor.config.ts", "src/plugins.ts"] as const;

/**
 * The selectable plugin names for a target: the manifest `plugins` list when
 * present, else the keys of `pluginRegistry`. These are the protocol/provider
 * plugins; the always-on secret/core plugins are never listed.
 */
const availablePlugins = (target: Target): ReadonlyArray<string> =>
  target.plugins ?? Object.keys(target.pluginRegistry ?? {});

/**
 * Validate the requested plugin set against the target's available plugins and
 * return the names to KEEP (deterministic order = the target's declared order).
 * An unknown requested plugin is a hard {@link ScaffoldPluginSelectionError}.
 */
const resolvePluginSelection = (
  target: Target,
  requested: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, ScaffoldPluginSelectionError> =>
  Effect.gen(function* () {
    const available = availablePlugins(target);
    const availableSet = new Set(available);
    for (const name of requested) {
      if (!availableSet.has(name)) {
        return yield* new ScaffoldPluginSelectionError({
          requested: name,
          available: [...available].sort(),
        });
      }
    }
    const requestedSet = new Set(requested);
    return available.filter((name) => requestedSet.has(name));
  });

/**
 * Remove the marker region for `plugin` from `text`. A region is the paired
 * line comments `// <executor:plugin:NAME>` ... `// </executor:plugin:NAME>`
 * (inclusive of both marker lines and everything between). Regions can repeat
 * (an import block and a constructor entry) — all occurrences are removed.
 */
const stripPluginRegion = (text: string, plugin: string): string => {
  const open = `// <executor:plugin:${plugin}>`;
  const close = `// </executor:plugin:${plugin}>`;
  const lines = text.split("\n");
  const out: Array<string> = [];
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === open) {
      depth += 1;
      continue;
    }
    if (trimmed === close) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out.push(line);
  }
  return out.join("\n");
};

/**
 * Strip the marker comment lines (but keep the enclosed plugin code) for every
 * plugin in `plugins`. Used for SELECTED plugins so the shipped scaffold has no
 * stray `// <executor:plugin:*>` comments.
 */
const stripPluginMarkerComments = (text: string, plugins: ReadonlyArray<string>): string => {
  if (plugins.length === 0) return text;
  const markerSet = new Set<string>();
  for (const plugin of plugins) {
    markerSet.add(`// <executor:plugin:${plugin}>`);
    markerSet.add(`// </executor:plugin:${plugin}>`);
  }
  return text
    .split("\n")
    .filter((line) => !markerSet.has(line.trim()))
    .join("\n");
};

/**
 * Apply the plugin selection to the overlaid scaffold's marked files: strip the
 * marker regions (code + markers) of every UNSELECTED plugin, then strip the
 * leftover marker comment lines of the SELECTED plugins (keeping their code).
 * Missing files are skipped.
 */
const applyPluginSelectionToFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dest: string,
  keep: ReadonlyArray<string>,
  drop: ReadonlyArray<string>,
): Effect.Effect<void, ScaffoldSourceError> =>
  Effect.forEach(
    PLUGIN_MARKED_FILES,
    (relative) =>
      Effect.gen(function* () {
        const filePath = path.join(dest, ...relative.split("/"));
        const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return;
        const original = yield* fs.readFileString(filePath).pipe(
          Effect.mapError(
            (cause) =>
              new ScaffoldSourceError({
                source: filePath,
                message: `failed to read '${relative}' for plugin stripping`,
                cause,
              }),
          ),
        );
        let next = original;
        for (const plugin of drop) next = stripPluginRegion(next, plugin);
        next = stripPluginMarkerComments(next, keep);
        if (next === original) return;
        yield* fs.writeFileString(filePath, next).pipe(
          Effect.mapError(
            (cause) =>
              new ScaffoldSourceError({
                source: filePath,
                message: `failed to write stripped '${relative}'`,
                cause,
              }),
          ),
        );
      }),
    { discard: true },
  );

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

/**
 * Resolve + apply a scaffold: obtain the templates tree, select the ordered
 * piece list, overlay each piece directory into `dest` (engine last wins), and
 * merge the deps / devDeps / env vars across pieces.
 *
 * @since 0.0.0
 */
export const resolve = (
  opts: ResolveOptions,
): Effect.Effect<ResolvedScaffold, ResolveError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // (a) obtain the templates tree + manifest.
    const tree = yield* obtainTree(opts.source);

    // (b) resolve the ordered piece list.
    const { target, pieces } = yield* selectPieces(tree.manifest, {
      target: opts.target,
      engine: opts.engine,
      auth: opts.auth,
    });

    // (b.1) resolve the plugin selection: validate the requested set against the
    // target's selectable plugins and compute keep/drop. The default (every
    // selectable plugin requested) keeps everything, so the scaffold is byte-for-
    // byte the baseline modulo the harmless marker comments being removed.
    const keepPlugins = yield* resolvePluginSelection(target, opts.plugins);
    const keepSet = new Set(keepPlugins);
    const dropPlugins = availablePlugins(target).filter((name) => !keepSet.has(name));

    // (c) overlay each piece dir into dest IN ORDER (later wins), unless dry-run.
    const dirsApplied: Array<string> = [];
    if (!opts.dryRun) {
      yield* fs.makeDirectory(opts.dest, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ScaffoldSourceError({
              source: opts.dest,
              message: "failed to create destination directory",
              cause,
            }),
        ),
      );
    }
    for (const piece of pieces) {
      const from = path.join(tree.root, ...piece.dir.split("/"));
      dirsApplied.push(piece.dir);
      if (opts.dryRun) continue;
      yield* fs.copy(from, opts.dest, { overwrite: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ScaffoldSourceError({
              source: from,
              message: `failed to overlay piece '${piece.dir}'`,
              cause,
            }),
        ),
      );
    }

    // (c.1) apply the plugin selection to the overlaid marked files: strip the
    // marker regions of unselected plugins (removing their import + constructor
    // entry) and strip leftover marker comments of the selected plugins. Skipped
    // under dry-run (nothing was written to strip).
    if (!opts.dryRun) {
      yield* applyPluginSelectionToFiles(fs, path, opts.dest, keepPlugins, dropPlugins);
    }

    // (d) merge deps / devDeps / env vars across pieces.
    const dependencies: Record<string, string> = {};
    const devDependencies: Record<string, string> = {};
    const envVars: Record<string, string> = {};
    for (const piece of pieces) {
      yield* mergeDependencies("dependencies", dependencies, piece.dependencies);
      yield* mergeDependencies("devDependencies", devDependencies, piece.devDependencies);
      for (const [name, value] of Record.toEntries(piece.envVars ?? {})) {
        envVars[name] = value;
      }
    }

    // (d.1) drop the npm deps of every UNSELECTED plugin from the merged maps,
    // using the target's plugin registry. Selected plugins (default-all) keep
    // every dep, so the baseline dep set is unchanged.
    const registry = target.pluginRegistry ?? {};
    for (const plugin of dropPlugins) {
      const entry = registry[plugin];
      if (entry === undefined) continue;
      for (const name of Object.keys(entry.dependencies ?? {})) {
        delete dependencies[name];
      }
      for (const name of Object.keys(entry.devDependencies ?? {})) {
        delete devDependencies[name];
      }
    }

    // (e) the package.json the writer rewrites is the one a piece laid into the
    // dest root during overlay (the manifest's packageJsonFrom piece ships it).
    const packageJsonTemplatePath = path.join(opts.dest, "package.json");

    return {
      dirsApplied,
      pluginsApplied: keepPlugins,
      dependencies: sortRecord(dependencies),
      devDependencies: sortRecord(devDependencies),
      envVars,
      packageJsonTemplatePath,
    } satisfies ResolvedScaffold;
  });
