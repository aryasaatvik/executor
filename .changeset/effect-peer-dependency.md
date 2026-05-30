---
"executor": patch
---

Move `effect` from `dependencies` to `peerDependencies` (with a `devDependencies` mirror) in the published library packages.

`effect` relies on a single module instance for `Context`/service identity and type equality. Declaring it as a hard dependency lets consumers end up with duplicated `effect` copies — e.g. an app on a newer `4.0.0-beta.x` installed alongside these packages' pinned version — which breaks service resolution and surfaces as TypeScript reporting the two `effect` copies as incompatible.

Declaring `effect` as a peer dependency lets the consuming app supply the single shared `effect` version. Consumers now need `effect` as a direct dependency. Private workspace packages and the `executor` CLI keep `effect` as a regular dependency.
