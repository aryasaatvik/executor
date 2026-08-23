# Rebase and promotion

Use this procedure for the Prepare and Promote phases.

## Prepare an isolated candidate

1. Fetch current `origin/dev` and `upstream/main` and record both full SHAs.
2. Require the canonical `dev`, selfhost, upstream, and hosted-instance checkouts to be clean.
3. Create a dedicated candidate from the captured dev SHA with `wt new`. Do not rebase the canonical `dev` checkout.
4. Run `bun run bootstrap` in the fresh candidate as required by the repository.
5. Rebase the fork series onto the captured upstream SHA with rerere enabled for the rebase commands. Do not enable or change global Git configuration.

The candidate branch name should identify the upstream date or SHA, for example `sync/upstream-2026-08-23`.

## Conflict policy

Resolve by ownership and intent, commit by commit:

- Preserve additive fork packages and plugins unless upstream now supplies an equivalent that is intentionally adopted.
- Prefer current upstream framework contracts, provider migrations, Durable Object/session behavior, and supported runtime seams.
- Reapply fork behavior through the new upstream seam instead of restoring removed upstream structure.
- Preserve service-token aliases, execution history, semantic search, host-specific OAuth health, and branded UI only where they remain deliberate fork features.
- For delete/modify and rename conflicts, inspect the upstream replacement and callers before choosing a destination.
- Resolve package manifests first, then regenerate `bun.lock`. Never edit lockfile conflict markers by hand.
- Search the candidate for conflict markers and inspect commits that became empty or changed scope.

Stop for an architectural decision when both sides deliberately changed the same contract or when a resolution would alter storage, authentication, execution isolation, or public APIs.

## Validate the candidate

Run focused tests after each meaningful conflict cluster. When the tree is settled, run the merge-ready repository gates:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
```

Do not silently omit a failing suite. Report an environmental limitation separately from a product failure and get approval for any exception.

Prepare a review report containing:

- captured old dev and upstream SHAs;
- new candidate SHA and range-diff;
- empty, dropped, or materially rewritten commits;
- conflict files and resolution rationale;
- upstream-only changes that affect the fork;
- full gate results;
- expected host-contract changes and migration risk.

## Review-only candidate PR

When review on GitHub is requested, push the candidate and open a PR against `dev` that explicitly says it is review-only and must not be merged. GitHub merging would retain the old base history instead of performing the intended ref promotion.

Required checks and reviews must apply to the exact current candidate head. A later force-push invalidates earlier evidence.

## Promote with an exact lease

Promotion is a separate destructive phase. Immediately before it:

1. Fetch `origin/dev` again.
2. Confirm it still equals the captured old dev SHA. Stop if it moved.
3. Create a dated backup ref containing the old dev SHA and push that backup when authorized.
4. Verify the candidate tree and reviewed tree are identical.
5. Update `dev` with an explicit lease tied to the old SHA:

```bash
git push --force-with-lease=refs/heads/dev:<old-dev-sha> origin <candidate-sha>:refs/heads/dev
```

6. Fetch and verify `origin/dev` is exactly the candidate SHA.
7. Update the canonical checkout without destructive reset commands.

Report the backup ref, old SHA, new SHA, and remote readback. Do not merge or close the review-only PR unless separately authorized.
