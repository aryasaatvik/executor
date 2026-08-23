# Selfhost update and deployment

Use this procedure only after the promoted `origin/dev` SHA is verified.

## Update linked package sources

1. Record the current detached selfhost SHA.
2. Require the selfhost checkout to be clean and detached.
3. Fetch the promoted ref and detach selfhost at its exact SHA.
4. Install with the checked-in lockfile rather than allowing dependency drift.
5. Build generated package output that the host cannot consume as TypeScript source, including `@executor-js/vite-plugin` when present.
6. Verify every hosted `link:@executor-js/*` dependency resolves inside the selfhost worktree and that no expected link is missing.

Do not make a repair commit directly in the detached selfhost checkout. Package fixes go through the fork history workflow.

## Reconcile the hosted instance

Compare the old and new fork host contract with `/Users/aryasaatvik/Developer/AryaLabsHQ/executor`. Do not copy the upstream app over the hosted repository.

If no host change is required, record the comparison and continue. If a change is required:

1. Create an isolated branch in the host repository.
2. Implement only required host composition changes.
3. Run the host gates and open a separate conventional PR.
4. Stop until that PR is reviewed and landed. Never deploy uncommitted host changes.

Preserve intentional hosted behavior including access authentication, service-token actor aliases, QuickJS execution when no Dynamic Worker binding is configured, D1/R2 state, semantic-search indexing, queues, observability, and custom plugin composition unless the upgrade explicitly replaces it.

## Migration gate

Diff the previously deployed package and host SHAs against the proposed deployment for storage schemas, migrations, bindings, queues, indexes, and persistent-object contracts.

If no migration is required, say so explicitly. If one is required, prepare a concrete plan containing:

- affected D1 tables and migration identifiers;
- pre-migration exports or backups;
- R2 objects or prefixes involved;
- Durable Object compatibility implications;
- queue/index rebuild or reconciliation steps;
- verification queries and rollback limits.

Require confirmation before executing remote migrations. Use the hosted repository's checked-in migration command and Wrangler configuration. Do not enable per-request schema setup to substitute for a planned one-time migration.

## Host validation

From the clean hosted repository, run the relevant checked-in commands, normally including:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run build
bunx wrangler deploy --dry-run
```

Use the actual package scripts when names differ. A package-only change still requires a host build because linked TypeScript source is compiled at deployment time.

## Deploy and verify

Immediately before production deployment:

1. Confirm the hosted repository is clean and at the reviewed SHA.
2. Confirm selfhost is detached at the promoted `dev` SHA.
3. Capture the current Worker version and relevant binding inventory.
4. Present the migration and deployment commands, expected versions, and rollback target.
5. Obtain explicit deployment confirmation.

Deploy through the hosted repository's Wrangler-backed command. Capture the resulting Worker version and read it back from Cloudflare.

Validate the authenticated customer path through Executor MCP, not the Executor CLI:

- AI Search/index health;
- representative semantic searches, including namespace-filtered searches;
- exact tool description;
- one safe read-only live tool execution;
- service-token actor attribution when relevant;
- Worker errors, latency, and telemetry around the validation window.

Browser validation may supplement MCP validation for user-visible changes but does not replace it.

If live validation fails, stop further mutation, gather Worker logs and the exact failing request, and compare with the recorded old versions. Do not automatically roll back unless rollback was explicitly authorized. Use Wrangler rollback only against the recorded previous Worker version.
