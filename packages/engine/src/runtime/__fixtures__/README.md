# Release Workspace Fixtures

These fixtures capture real `.executor` workspace layouts from released versions so newer code can test upgrade behavior against actual on-disk state.

Each fixture directory should contain:

- `fixture.json`: release metadata and the expected artifact outcome
- `.executor/executor.jsonc`: a trimmed project config with only the captured source
- `.executor/state/executor.db`: the captured SQLite state for that workspace

`src/runtime/local/source-artifacts.test.ts` auto-discovers every fixture directory here that has a `fixture.json` file. Adding a new release fixture should not require changing the test.

## Capture A New Release Fixture

From the repo root:

```bash
bun run fixture:release:capture -- \
  --workspace-root /path/to/workspace \
  --source-id google-calendar \
  --release-version v1.2.4-beta.1 \
  --artifact-expectation readable \
  --description "Google Calendar workspace captured from v1.2.4-beta.1"
```

Use `cache-miss` instead of `readable` when a future runtime should intentionally discard that artifact and resync it.

The capture command writes a new fixture directory under this folder using the pattern `<release-version>-<source-id>-workspace`.

## Release Checklist

On releases where you want upgrade coverage:

1. Start from a real workspace that has a fully synced source on the released version.
2. Run `bun run fixture:release:capture -- ...` for that source.
3. Review the fixture for secrets before committing it.
4. Run `bun run --cwd packages/engine test -- src/runtime/local/source-artifacts.test.ts`.
