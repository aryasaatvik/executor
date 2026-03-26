import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildDistributionPackage } from "./artifact";
import { readDistributionPackageMetadata, repoRoot } from "./metadata";

const defaultReleaseDir = resolve(repoRoot, "apps/executor/dist/release");
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

type PublishCliOptions = {
  dryRun: boolean;
};

type CommandInput = {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
};

type CommandOutput = {
  stdout: string;
  stderr: string;
};

type PackResult = {
  filename?: string;
};

const parseArgs = (argv: ReadonlyArray<string>): PublishCliOptions => {
  const options: PublishCliOptions = {
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

const runCommand = async (input: CommandInput): Promise<CommandOutput> => {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolveExitCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolveExitCode(code ?? -1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(
      [
        `${input.command} ${input.args.join(" ")} exited with code ${exitCode}`,
        stdout.trim().length > 0 ? `stdout:\n${stdout.trim()}` : null,
        stderr.trim().length > 0 ? `stderr:\n${stderr.trim()}` : null,
      ]
        .filter((part) => part !== null)
        .join("\n\n"),
    );
  }

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
};

const resolveTagFromEnvironment = (): string | undefined => {
  const refName = process.env.GITHUB_REF_NAME?.trim();
  if (process.env.GITHUB_REF_TYPE === "tag" && refName) {
    return refName;
  }

  const ref = process.env.GITHUB_REF?.trim();
  if (ref?.startsWith("refs/tags/")) {
    return ref.slice("refs/tags/".length);
  }

  return undefined;
};

const resolveGitHubRepository = (): string => {
  const repository = process.env.GH_REPO?.trim() || process.env.GITHUB_REPOSITORY?.trim();
  if (!repository) {
    throw new Error("Set GH_REPO or GITHUB_REPOSITORY before creating a GitHub release.");
  }

  return repository;
};

const validateVersion = (version: string): void => {
  if (!semverPattern.test(version)) {
    throw new Error(`apps/executor/package.json version is not valid semver: ${version}`);
  }
};

const resolveChannel = (version: string): "latest" | "beta" =>
  version.includes("-") ? "beta" : "latest";

const packDistributionPackage = async (releaseDir: string): Promise<string> => {
  const output = await runCommand({
    command: "npm",
    args: ["pack", "./apps/executor/dist/npm", "--pack-destination", releaseDir, "--json"],
    cwd: repoRoot,
  });
  const [result] = JSON.parse(output.stdout) as ReadonlyArray<PackResult>;
  const filename = result?.filename;

  if (!filename) {
    throw new Error(`npm pack did not report an output filename. stdout:\n${output.stdout}`);
  }

  return join(releaseDir, filename);
};

const publishDistributionPackage = async (channel: "latest" | "beta"): Promise<void> => {
  const args = ["publish", "./dist/npm", "--access", "public", "--tag", channel];
  if (process.env.GITHUB_ACTIONS === "true") {
    args.push("--provenance");
  }

  await runCommand({
    command: "npm",
    args,
    cwd: resolve(repoRoot, "apps/executor"),
  });
};

const createGitHubRelease = async (input: {
  tag: string;
  channel: "latest" | "beta";
  assetPath: string;
}): Promise<void> => {
  if (!process.env.GH_TOKEN?.trim()) {
    throw new Error("GH_TOKEN is required to create a GitHub release.");
  }

  const args = [
    "release",
    "create",
    input.tag,
    input.assetPath,
    "--repo",
    resolveGitHubRepository(),
    "--title",
    input.tag,
    "--generate-notes",
    "--verify-tag",
  ];

  if (input.channel === "beta") {
    args.push("--prerelease");
  } else {
    args.push("--latest");
  }

  await runCommand({
    command: "gh",
    args,
    cwd: repoRoot,
  });
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const metadata = await readDistributionPackageMetadata();
  const version = metadata.version;
  const tag = `v${version}`;
  const refTag = resolveTagFromEnvironment();

  validateVersion(version);

  if (refTag && refTag !== tag) {
    throw new Error(`GitHub tag ${refTag} does not match apps/executor/package.json version ${version}`);
  }

  const channel = resolveChannel(version);
  await rm(defaultReleaseDir, { recursive: true, force: true });
  await mkdir(defaultReleaseDir, { recursive: true });

  await buildDistributionPackage();
  const archivePath = await packDistributionPackage(defaultReleaseDir);

  process.stdout.write(`Prepared executor@${version} for ${channel}\n`);
  process.stdout.write(`${archivePath}\n`);

  if (options.dryRun) {
    return;
  }

  await publishDistributionPackage(channel);
  await createGitHubRelease({
    tag,
    channel,
    assetPath: archivePath,
  });
};

await main();
