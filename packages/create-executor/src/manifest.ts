/**
 * Schema for `templates/manifest.json` — the single composition manifest that
 * declares, per host target, how to compose a scaffold from template pieces.
 *
 * The manifest declares, for each host `target`, how to compose a scaffold from
 * a set of template "pieces" (directories under `templatesDir`). A piece is a
 * directory whose tree is overlaid into the destination, plus optional npm
 * dependency maps and env vars. The resolver layers pieces in a fixed order
 * (`base -> overlays -> auth -> engine`) so a later piece's files win on
 * collision and its dependency declarations merge into the running maps.
 *
 * Shape:
 *
 *   {
 *     "version": 1,
 *     "source": { "repo": "owner/repo", "ref": "main", "templatesDir": "templates" },
 *     "targets": {
 *       "<target>": {
 *         "base": Piece,
 *         "overlays"?: Piece[],
 *         "engines": { "default": "<engine>", "choices": { "<engine>": Piece } },
 *         "auth"?: { "default": "<auth>", "choices": { "<auth>": Piece } },
 *         "plugins"?: ["<plugin>", ...],
 *         "packageJsonFrom": "<piece-relative-dir>"
 *       }
 *     }
 *   }
 *
 * A {@link Piece} carries its own template `dir` (relative to `templatesDir`)
 * plus the npm deps / env vars it contributes when selected.
 *
 * @since 0.0.0
 */
import { Schema } from "effect";
import type { Effect } from "effect";

// ---------------------------------------------------------------------------
// Piece
// ---------------------------------------------------------------------------

/**
 * A single composable template unit.
 *
 * - `dir`: directory (relative to `source.templatesDir`) whose tree is overlaid
 *   into the destination when this piece is selected.
 * - `dependencies` / `devDependencies`: npm `name -> range` maps merged into the
 *   scaffold's package.json. Conflicting ranges across pieces are a hard error.
 * - `envVars`: `name -> default` map merged into the scaffold's env surface and
 *   used to drive the printed next-steps.
 *
 * @since 0.0.0
 */
export const Piece = Schema.Struct({
  dir: Schema.String,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  envVars: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/**
 * @since 0.0.0
 */
export type Piece = typeof Piece.Type;

// ---------------------------------------------------------------------------
// Engine / auth selection
// ---------------------------------------------------------------------------

/**
 * A selectable set of pieces with a declared default. Used for both `engines`
 * and `auth`.
 *
 * @since 0.0.0
 */
export const PieceSelection = Schema.Struct({
  default: Schema.String,
  choices: Schema.Record(Schema.String, Piece),
});

/**
 * @since 0.0.0
 */
export type PieceSelection = typeof PieceSelection.Type;

// ---------------------------------------------------------------------------
// Plugin registry entry
// ---------------------------------------------------------------------------

/**
 * The npm dependency footprint a single selectable protocol plugin pulls into
 * the scaffold's `package.json`. Keyed by plugin name in a target's
 * {@link Target.pluginRegistry}.
 *
 * Selecting a plugin keeps its template marker region (its import + constructor
 * entry) and merges these deps; deselecting strips the region and drops these
 * deps. Only the protocol/provider plugins are selectable — the always-on
 * secret/core plugins (encrypted-secrets, keychain, file-secrets) are not in the
 * registry and stay in every scaffold.
 *
 * @since 0.0.0
 */
export const PluginEntry = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/**
 * @since 0.0.0
 */
export type PluginEntry = typeof PluginEntry.Type;

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/**
 * One host target's composition: the always-applied `base` piece, optional
 * `overlays`, a required `engines` selection, an optional `auth` selection, an
 * optional `plugins` list (the default selectable plugin set — every name here
 * must have a matching {@link pluginRegistry} entry), an optional
 * `pluginRegistry` mapping each selectable plugin name to the npm deps it pulls
 * (used to drop deps when a plugin is deselected), and the piece-relative
 * directory whose `package.json` seeds the final `package.json`.
 *
 * @since 0.0.0
 */
export const Target = Schema.Struct({
  base: Piece,
  overlays: Schema.optional(Schema.Array(Piece)),
  engines: PieceSelection,
  auth: Schema.optional(PieceSelection),
  plugins: Schema.optional(Schema.Array(Schema.String)),
  pluginRegistry: Schema.optional(Schema.Record(Schema.String, PluginEntry)),
  packageJsonFrom: Schema.String,
});

/**
 * @since 0.0.0
 */
export type Target = typeof Target.Type;

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * Where the templates tree lives for the remote (giget) path: the GitHub
 * `owner/repo`, the default `ref`, and the subdirectory holding the manifest +
 * piece directories.
 *
 * @since 0.0.0
 */
export const ManifestSource = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  templatesDir: Schema.String,
});

/**
 * @since 0.0.0
 */
export type ManifestSource = typeof ManifestSource.Type;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * The full `templates/manifest.json` document.
 *
 * @since 0.0.0
 */
export const Manifest = Schema.Struct({
  version: Schema.Number,
  source: ManifestSource,
  targets: Schema.Record(Schema.String, Target),
});

/**
 * @since 0.0.0
 */
export type Manifest = typeof Manifest.Type;

/**
 * Decode a `manifest.json` text into a {@link Manifest}: parse the JSON and
 * validate it against the schema in one step via {@link Schema.fromJsonString}.
 * Fails with the Effect Schema `SchemaError` (a tagged error carrying `.issue`)
 * for both invalid JSON and a schema mismatch; the resolver wraps this into its
 * own tagged error with source context.
 *
 * @since 0.0.0
 */
export const decodeManifest = (raw: string): Effect.Effect<Manifest, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(raw);
