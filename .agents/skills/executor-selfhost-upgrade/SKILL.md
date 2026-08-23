---
name: executor-selfhost-upgrade
description: Rebase the Executor dev fork onto current upstream/main, promote the reviewed history safely, update the linked selfhost checkout, reconcile the AryaLabsHQ Cloudflare host, and deploy with explicit production gates. Use for full upstream-to-executor.arya.sh upgrades, not ordinary feature PRs.
---

# Executor selfhost upgrade

Upgrade the fork and hosted instance without conflating their three repositories or silently widening authorization.

## Choose the phase

Start in the least-mutating phase that satisfies the request:

- **Inspect** is read-only. Refresh remote-tracking refs when current upstream state is requested, run the preflight helper, and report drift.
- **Prepare** creates an isolated rebase candidate, resolves supported conflicts, and validates it. It does not change `dev`, selfhost, or production.
- **Promote** rewrites `dev` to the reviewed candidate. Require explicit confirmation immediately before the exact force-with-lease.
- **Deploy** updates the detached selfhost checkout, reconciles the host, handles required migrations, deploys, and verifies live. Require explicit confirmation immediately before migrations or production deployment.

An approval for one phase does not authorize a later phase. A request to discuss or inspect is not permission to mutate refs, files, provider state, or production.

## Required reading

Before any phase, read [references/topology.md](references/topology.md).

- For Prepare or Promote, also read [references/rebase.md](references/rebase.md).
- For Deploy, also read [references/deploy.md](references/deploy.md).

## Preflight

From any checkout in the Executor worktree family, run:

```bash
bun .agents/skills/executor-selfhost-upgrade/scripts/preflight.ts
```

Use `--json` when another tool will consume the result. The helper is deliberately read-only: it does not fetch, switch branches, install packages, migrate data, or deploy.

Treat every reported blocker as a stop condition. Resolve stale remote-tracking refs by fetching deliberately, then rerun preflight. Do not reinterpret a dirty checkout as safe.

## Shared invariants

- Keep the canonical `dev` checkout, detached selfhost checkout, and hosted-instance repository distinct.
- Use exact SHAs in reports and mutation commands. Re-resolve them immediately before promotion and deployment.
- Use `wt new` for isolated Executor worktrees.
- Preserve unrelated worktrees and user changes.
- Never resolve semantic conflicts with blanket `ours` or `theirs` choices.
- Never hand-merge `bun.lock`; regenerate it with the repository's Bun version after resolving manifests.
- Do not overwrite the hosted instance with `apps/host-cloudflare`. Reconcile intentional host composition instead.
- Use Wrangler for Cloudflare migrations, deployment, version inspection, and rollback.
- Use Executor only through MCP for live service inspection and verification. Never use the Executor CLI.
- Record the old `dev` SHA, selfhost SHA, hosted-instance SHA, and deployed Worker version before their respective mutations.

## Checkpoints and stopping conditions

Stop and ask for direction when:

- a conflict changes public contracts, storage semantics, authentication, execution runtime behavior, or plugin composition;
- any owned checkout is dirty;
- `origin/dev` changes after the promotion lease is captured;
- a required hosted-instance change cannot be represented by a separate reviewed host PR;
- migration ordering, backup coverage, or reversibility is unclear;
- a required verification gate fails;
- live validation shows a regression or cannot reach the authenticated service.

Do not merge pull requests. A rebase candidate PR is review-only; promotion uses the exact guarded ref update described in the rebase reference. A host PR is a separate repository change and blocks deployment until reviewed and landed.
