#!/usr/bin/env bun

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

interface Worktree {
  readonly path: string;
  readonly branch: string | null;
  readonly detached: boolean;
}

interface RepoState {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly clean: boolean | null;
}

interface Check {
  readonly severity: "blocker" | "warning" | "ok";
  readonly name: string;
  readonly detail: string;
}

interface Options {
  readonly json: boolean;
  readonly main?: string;
  readonly selfhost?: string;
  readonly upstream?: string;
  readonly host?: string;
}

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const decoder = new TextDecoder();

const run = (command: readonly string[], cwd?: string): CommandResult => {
  const result = Bun.spawnSync([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    ok: result.exitCode === 0,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
};

const git = (repository: string, ...args: readonly string[]) =>
  run(["git", "-C", repository, ...args]);

const parseOptions = (args: readonly string[]): Options => {
  const values: {
    json: boolean;
    main?: string;
    selfhost?: string;
    upstream?: string;
    host?: string;
  } = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      values.json = true;
      continue;
    }

    const option = argument.replace(/^--/, "") as keyof Omit<Options, "json">;
    if (!["main", "selfhost", "upstream", "host"].includes(option)) {
      process.stderr.write(`Unknown option: ${argument}\n`);
      process.exit(2);
    }

    const value = args[index + 1];
    if (!value) {
      process.stderr.write(`Missing value for ${argument}\n`);
      process.exit(2);
    }
    values[option] = resolve(value);
    index += 1;
  }

  return values;
};

const parseWorktrees = (output: string): readonly Worktree[] =>
  output.split(/\n\n+/).flatMap((record): readonly Worktree[] => {
    const lines = record.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    if (!path) return [];
    const branch = lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null;
    return [
      {
        path,
        branch,
        detached: lines.includes("detached"),
      },
    ];
  });

const resolveCanonicalMain = (override?: string): string => {
  if (override) return override;

  const root = run(["git", "rev-parse", "--show-toplevel"]);
  if (!root.ok) {
    process.stderr.write("Run preflight from an Executor Git checkout or pass --main.\n");
    process.exit(2);
  }

  const common = git(root.stdout, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common.ok) return root.stdout;
  return basename(common.stdout) === ".git" ? dirname(common.stdout) : root.stdout;
};

const repoState = (path: string): RepoState => {
  if (!existsSync(path)) {
    return { path, head: null, branch: null, clean: null };
  }

  const head = git(path, "rev-parse", "HEAD");
  const branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD");
  const status = git(path, "status", "--porcelain");
  return {
    path,
    head: head.ok ? head.stdout : null,
    branch: branch.ok ? branch.stdout : null,
    clean: status.ok ? status.stdout.length === 0 : null,
  };
};

const addRepoChecks = (
  checks: Check[],
  label: string,
  state: RepoState,
  expectedBranch: string | null,
) => {
  if (state.head === null) {
    checks.push({ severity: "blocker", name: `${label}.exists`, detail: state.path });
    return;
  }
  checks.push({ severity: "ok", name: `${label}.exists`, detail: state.path });

  if (state.clean !== true) {
    checks.push({
      severity: "blocker",
      name: `${label}.clean`,
      detail: state.clean === false ? "working tree has changes" : "unable to read status",
    });
  } else {
    checks.push({ severity: "ok", name: `${label}.clean`, detail: "clean" });
  }

  if (state.branch !== expectedBranch) {
    checks.push({
      severity: "blocker",
      name: `${label}.branch`,
      detail: `expected ${expectedBranch ?? "detached HEAD"}, found ${state.branch ?? "detached HEAD"}`,
    });
  } else {
    checks.push({
      severity: "ok",
      name: `${label}.branch`,
      detail: expectedBranch ?? "detached HEAD",
    });
  }
};

const expectedExecutorPackages = (hostPath: string): readonly string[] => {
  const packagePath = join(hostPath, "package.json");
  if (!existsSync(packagePath)) return [];

  // oxlint-disable-next-line executor/no-json-parse -- boundary: package.json is a trusted local tooling manifest
  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
  return Object.entries({ ...parsed.dependencies, ...parsed.devDependencies })
    .filter(([name, value]) => name.startsWith("@executor-js/") && value.startsWith("link:"))
    .map(([name]) => name)
    .sort();
};

const inspectLinks = (hostPath: string, selfhostPath: string) => {
  const expected = expectedExecutorPackages(hostPath);
  const missing: string[] = [];
  const outsideSelfhost: { name: string; target: string }[] = [];
  const canonicalSelfhostPath = existsSync(selfhostPath)
    ? realpathSync(selfhostPath)
    : selfhostPath;

  for (const name of expected) {
    const packageName = name.slice("@executor-js/".length);
    const linkPath = join(hostPath, "node_modules", "@executor-js", packageName);
    if (!existsSync(linkPath)) {
      missing.push(name);
      continue;
    }

    const target = realpathSync(linkPath);
    const relativeTarget = relative(canonicalSelfhostPath, target);
    const isInsideSelfhost =
      relativeTarget === "" || (!relativeTarget.startsWith("..") && !isAbsolute(relativeTarget));
    if (!isInsideSelfhost) outsideSelfhost.push({ name, target });
  }

  return { expected, missing, outsideSelfhost };
};

const options = parseOptions(process.argv.slice(2));
const mainPath = resolveCanonicalMain(options.main);
const worktreeResult = git(mainPath, "worktree", "list", "--porcelain");
if (!worktreeResult.ok) {
  process.stderr.write(`${worktreeResult.stderr || "Unable to list Executor worktrees"}\n`);
  process.exit(2);
}

const worktrees = parseWorktrees(worktreeResult.stdout);
const findWorktree = (name: string) =>
  worktrees.find((worktree) => basename(worktree.path) === name)?.path;
const selfhostPath =
  options.selfhost ??
  findWorktree("selfhost") ??
  join(dirname(mainPath), "executor-worktrees", "selfhost");
const upstreamPath =
  options.upstream ??
  findWorktree("upstream") ??
  join(dirname(mainPath), "executor-worktrees", "upstream");
const configuredHostPath = options.host ?? process.env.EXECUTOR_HOST_CHECKOUT;
const hostPath = configuredHostPath
  ? resolve(configuredHostPath)
  : join(dirname(mainPath), "executor-host");

const main = repoState(mainPath);
const selfhost = repoState(selfhostPath);
const upstream = repoState(upstreamPath);
const host = repoState(hostPath);
const checks: Check[] = [];

addRepoChecks(checks, "main", main, "dev");
addRepoChecks(checks, "selfhost", selfhost, null);
addRepoChecks(checks, "upstream", upstream, null);
addRepoChecks(checks, "host", host, "main");

const originDevResult = git(mainPath, "rev-parse", "refs/remotes/origin/dev");
const upstreamMainResult = git(mainPath, "rev-parse", "refs/remotes/upstream/main");
const originDev = originDevResult.ok ? originDevResult.stdout : null;
const upstreamMain = upstreamMainResult.ok ? upstreamMainResult.stdout : null;

if (!originDev)
  checks.push({ severity: "blocker", name: "refs.origin-dev", detail: "missing origin/dev" });
if (!upstreamMain)
  checks.push({ severity: "blocker", name: "refs.upstream-main", detail: "missing upstream/main" });

if (originDev && main.head !== originDev) {
  checks.push({
    severity: "blocker",
    name: "main.alignment",
    detail: `HEAD ${main.head} != origin/dev ${originDev}`,
  });
} else if (originDev) {
  checks.push({ severity: "ok", name: "main.alignment", detail: originDev });
}

if (originDev && selfhost.head !== originDev) {
  checks.push({
    severity: "warning",
    name: "selfhost.alignment",
    detail: `HEAD ${selfhost.head} != origin/dev ${originDev}`,
  });
} else if (originDev) {
  checks.push({ severity: "ok", name: "selfhost.alignment", detail: originDev });
}

if (upstreamMain && upstream.head !== upstreamMain) {
  checks.push({
    severity: "warning",
    name: "upstream.alignment",
    detail: `HEAD ${upstream.head} != upstream/main ${upstreamMain}`,
  });
} else if (upstreamMain) {
  checks.push({ severity: "ok", name: "upstream.alignment", detail: upstreamMain });
}

const divergenceResult =
  originDev && upstreamMain
    ? git(mainPath, "rev-list", "--left-right", "--count", `${upstreamMain}...${originDev}`)
    : { ok: false, stdout: "", stderr: "missing refs" };
const [upstreamOnly, forkOnly] = divergenceResult.ok
  ? divergenceResult.stdout.split(/\s+/).map((value) => Number.parseInt(value, 10))
  : [null, null];
const mergeBaseResult =
  originDev && upstreamMain
    ? git(mainPath, "merge-base", originDev, upstreamMain)
    : { ok: false, stdout: "", stderr: "missing refs" };

const links = inspectLinks(hostPath, selfhostPath);
if (links.expected.length === 0) {
  checks.push({
    severity: "warning",
    name: "links.expected",
    detail: "no link:@executor-js/* dependencies found",
  });
} else {
  checks.push({
    severity: "ok",
    name: "links.expected",
    detail: `${links.expected.length} linked packages declared`,
  });
}
if (links.missing.length > 0) {
  checks.push({ severity: "blocker", name: "links.missing", detail: links.missing.join(", ") });
}
if (links.outsideSelfhost.length > 0) {
  checks.push({
    severity: "blocker",
    name: "links.targets",
    detail: links.outsideSelfhost.map(({ name, target }) => `${name} -> ${target}`).join(", "),
  });
} else if (links.expected.length > 0) {
  checks.push({
    severity: "ok",
    name: "links.targets",
    detail: "all linked packages resolve inside selfhost",
  });
}

const blockers = checks.filter((check) => check.severity === "blocker");
const warnings = checks.filter((check) => check.severity === "warning");
const report = {
  status: blockers.length === 0 ? "ready" : "blocked",
  generatedAt: new Date().toISOString(),
  note: "Read-only local inspection. Remote-tracking refs were not fetched.",
  repositories: { main, selfhost, upstream, host },
  refs: {
    originDev,
    upstreamMain,
    mergeBase: mergeBaseResult.ok ? mergeBaseResult.stdout : null,
    divergence: { upstreamOnly, forkOnly },
  },
  links,
  checks,
};

if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`Executor selfhost upgrade preflight: ${report.status.toUpperCase()}\n`);
  process.stdout.write(`origin/dev:    ${originDev ?? "missing"}\n`);
  process.stdout.write(`upstream/main: ${upstreamMain ?? "missing"}\n`);
  process.stdout.write(
    `divergence:    ${upstreamOnly ?? "?"} upstream-only, ${forkOnly ?? "?"} fork-only\n`,
  );
  process.stdout.write(
    `linked source: ${links.expected.length} declared, ${links.missing.length} missing, ${links.outsideSelfhost.length} outside selfhost\n`,
  );
  for (const check of [...blockers, ...warnings]) {
    process.stdout.write(`${check.severity.toUpperCase()}: ${check.name}: ${check.detail}\n`);
  }
}

process.exit(blockers.length === 0 ? 0 : 1);
