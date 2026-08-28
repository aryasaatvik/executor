# Executor upgrade topology

Use live Git and filesystem state as the authority. The preflight helper discovers the Executor worktree family and accepts explicit path overrides.

## Checkouts

| Role              | Discovery or override                                                                                                             | Ownership                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Fork history      | Worktree on `dev`, or `--main`                                                                                                    | Git history, ordinary feature PRs, and upstream-rebase promotion                                                |
| Linked packages   | Worktree named `selfhost`, or `--selfhost`                                                                                        | Detached checkout whose `packages/**/src` files are consumed by the hosted instance through `bun link` symlinks |
| Upstream snapshot | Worktree named `upstream`, or `--upstream`                                                                                        | Clean detached view of the exact fetched `upstream/main` SHA                                                    |
| Hosted instance   | `--host`, `EXECUTOR_HOST_CHECKOUT`, repo-local `executor.hostCheckout`, or unique nearby `link:@executor-js/*` consumer discovery | Cloudflare composition deployed for this fork                                                                   |

The hosted repository consumes `@executor-js/*` as TypeScript source through links into the selfhost checkout. A successful build in the fork history checkout does not prove that those links or the hosted composition are correct.

Host resolution is deterministic in the order shown above. Automatic discovery checks Git repositories at most two directories below the Executor workspace parent and accepts a result only when exactly one manifest declares linked Executor packages. If multiple hosts match, pass `--host` or persist the checkout for this worktree family:

```bash
git config executor.hostCheckout /absolute/path/to/host
```

## Source-of-truth rules

- Package and plugin changes belong in the Executor monorepo, initially in an isolated candidate and ultimately on `dev`.
- Host-only bindings, routes, secrets wiring, migrations, queues, and deployment configuration belong in the configured hosted repository.
- The selfhost worktree is an exact detached package source. Do not develop unique changes there during an upgrade.
- The upstream worktree is an inspection surface. Do not create fork commits there.

## Read-only refresh

When current upstream state is required:

1. Inspect all worktrees and the four owned checkouts.
2. Fetch `origin` and `upstream`. If local tag conflicts would make an ordinary fetch unsafe, fetch branch tips with `--no-tags` instead of modifying tags.
3. Capture `origin/dev` and `upstream/main` as full SHAs.
4. Run preflight before changing either detached worktree.
5. If the upstream worktree is clean, detach it at the captured upstream SHA.
6. Rerun preflight and preserve its output in the upgrade report.

Refreshing remote-tracking refs is not permission to rebase, promote, migrate, or deploy.

## Hosted-instance contract

Treat `apps/host-cloudflare` as a reference composition, not a directory to copy. Compare it with the configured hosted repository for changes in:

- environment and binding contracts;
- Durable Object and hibernation/session wiring;
- execution runtime and QuickJS preload behavior;
- MCP transport and authentication;
- plugin construction and provider presets;
- storage schema and migration machinery;
- queues, AI Search, R2, D1, and observability.

Classify each difference as upstream-required, fork-required, host-specific, or stale. Only upstream-required changes should be ported automatically into a host change proposal.
