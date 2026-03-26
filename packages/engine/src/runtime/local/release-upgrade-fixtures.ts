import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";

import { resolveLocalWorkspaceContext } from "./config";

export const ReleaseWorkspaceFixtureArtifactExpectationSchema = Schema.Literal(
  "readable",
  "cache-miss",
);

export const ReleaseWorkspaceFixtureManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("release-workspace"),
  id: Schema.String,
  releaseVersion: Schema.String,
  sourceId: Schema.String,
  artifactExpectation: ReleaseWorkspaceFixtureArtifactExpectationSchema,
  description: Schema.optional(Schema.String),
});

export type ReleaseWorkspaceFixtureManifest =
  typeof ReleaseWorkspaceFixtureManifestSchema.Type;

export type ReleaseWorkspaceFixture = ReleaseWorkspaceFixtureManifest & {
  readonly rootDirectory: string;
};

export const releaseWorkspaceFixturesRoot = fileURLToPath(
  new URL("../__fixtures__", import.meta.url),
);

const decodeReleaseWorkspaceFixtureManifest = Schema.decodeUnknownSync(
  Schema.parseJson(ReleaseWorkspaceFixtureManifestSchema),
);

const sanitizeFixtureSegment = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const defaultReleaseWorkspaceFixtureDirectoryName = (input: {
  releaseVersion: string;
  sourceId: string;
}): string =>
  `${sanitizeFixtureSegment(input.releaseVersion)}-${sanitizeFixtureSegment(input.sourceId)}-workspace`;

export const releaseWorkspaceFixtures: readonly ReleaseWorkspaceFixture[] =
  readdirSync(releaseWorkspaceFixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const rootDirectory = join(releaseWorkspaceFixturesRoot, entry.name);
      const manifestPath = join(rootDirectory, "fixture.json");

      if (!existsSync(manifestPath)) {
        return [];
      }

      const manifest = decodeReleaseWorkspaceFixtureManifest(
        readFileSync(manifestPath, "utf8"),
      );
      return [{ ...manifest, rootDirectory }];
    })
    .sort(
      (left, right) =>
        left.releaseVersion.localeCompare(right.releaseVersion) ||
        left.id.localeCompare(right.id),
    );

export const resolveReleaseWorkspaceFixtureContext = (
  fixture: ReleaseWorkspaceFixture,
) =>
  resolveLocalWorkspaceContext({
    workspaceRoot: fixture.rootDirectory,
    homeConfigPath: join(fixture.rootDirectory, ".executor-home.jsonc"),
    homeStateDirectory: join(fixture.rootDirectory, ".executor-home-state"),
  });
