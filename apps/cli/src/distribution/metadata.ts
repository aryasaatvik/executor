import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const packageMetadataPath = resolve(repoRoot, "apps/executor/package.json");

export type DistributionPackageMetadata = {
  name: string;
  version: string;
  description: string;
  keywords: ReadonlyArray<string>;
  homepage?: string;
  bugs?: {
    url?: string;
  };
  repository?: {
    type?: string;
    url?: string;
  };
  license?: string;
};

export const readDistributionPackageMetadata = async (): Promise<DistributionPackageMetadata> => {
  const contents = await readFile(packageMetadataPath, "utf8");
  const metadata = JSON.parse(contents) as Partial<DistributionPackageMetadata>;

  return {
    name: metadata.name ?? "executor",
    version: metadata.version ?? "0.0.0-local",
    description: metadata.description ?? "Local AI executor with a CLI, local API server, and web UI.",
    keywords: Array.isArray(metadata.keywords) ? metadata.keywords.filter((value): value is string => typeof value === "string") : ["executor", "ai", "agent", "cli"],
    homepage: metadata.homepage,
    bugs: metadata.bugs,
    repository: metadata.repository,
    license: metadata.license ?? "MIT",
  };
};
