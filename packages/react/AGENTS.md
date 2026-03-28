# executor/clients/react

React hooks and context provider for the executor REST API. Uses plain `fetch()` and types from `@executor/api`. No Effect dependency.

## Provider

```tsx
import { ExecutorReactProvider } from "@executor/react";

<ExecutorReactProvider baseUrl="http://localhost:8788">
  {children}
</ExecutorReactProvider>
```

- Provider takes a `baseUrl` pointing to the selected executor's HTTP origin
- Defaults to `http://127.0.0.1:8788` if not specified
- Manages an invalidation counter — calling `invalidateQueries()` bumps it, causing all `useFetch`-based hooks to refetch

## Query Hooks

Return `Loadable<T>`: `{ status: "loading" } | { status: "error", error: Error } | { status: "ready", data: T }`

| Hook | Data |
|------|------|
| `useDiscover()` | `ExecutorDescriptor` — executor identity |
| `useHealth()` | `HealthResponse` — health check |
| `useLocalInstallation()` | `LocalInstallation` — workspace/account IDs (shim over /discover) |
| `useInstanceConfig()` | `InstanceConfig` — instance settings |
| `useSources()` | `ReadonlyArray<Source>` — all sources |
| `useSource(id)` | `Source` — single source by ID |
| `useSourceInspection(id)` | `SourceInspection` — tools + auth info |
| `useSourceToolDetail(id, toolPath)` | `SourceInspectionToolDetail \| null` |
| `useSourceDiscovery({ sourceId, query, limit? })` | `SourceInspectionDiscoverResult` |
| `useToolSearch(query)` | `ToolSearchResultSet` |
| `useExecutions()` | `ReadonlyArray<ExecutionRecord>` |
| `useExecution(id)` | `ExecutionEnvelope` |
| `useExecutionSteps(executionId)` | `ReadonlyArray<ExecutionStep>` |
| `useSecrets()` | `ReadonlyArray<SecretListItem>` |
| `useWorkspaceOauthClients(providerKey)` | `ReadonlyArray<WorkspaceOauthClient>` |

## Mutation Hooks

Return `{ status, data, error, mutateAsync, reset }`.

| Hook | Payload | Result |
|------|---------|--------|
| `useCreateSource()` | `CreateSourceRequest` | `Source` |
| `useUpdateSource()` | `{ sourceId, payload: UpdateSourceRequest }` | `Source` |
| `useRemoveSource()` | `string` (sourceId) | `{ removed: boolean }` |
| `useDiscoverSource()` | `DiscoverSourcePayload` | `SourceDiscoveryResult` |
| `useConnectSource()` | `ConnectSourcePayload` | `ConnectSourceResult` |
| `useConnectSourceBatch()` | `ConnectSourceBatchPayload` | `ConnectSourceBatchResult` |
| `useStartSourceOAuth()` | `StartSourceOAuthPayload` | `StartSourceOAuthResult` |
| `useCreateExecution()` | `CreateExecutionRequest` | `ExecutionEnvelope` |
| `useResumeExecution()` | `{ executionId, payload }` | `ExecutionEnvelope` |
| `useCreateSecret()` | `CreateSecretRequest` | `CreateSecretResponse` |
| `useUpdateSecret()` | `{ secretId, payload }` | `UpdateSecretResponse` |
| `useDeleteSecret()` | `string` (secretId) | `DeleteSecretResponse` |
| `useUpdateInstanceConfig()` | `{ semanticSearch: ... }` | `InstanceConfig` |
| `useCreateWorkspaceOauthClient()` | `CreateWorkspaceOauthClientPayload` | `WorkspaceOauthClient` |
| `useRemoveWorkspaceOauthClient()` | `string` (clientId) | `{ removed: boolean }` |
| `useRemoveProviderAuthGrant()` | `string` (grantId) | `{ removed: boolean }` |

All mutations invalidate queries on success.

## Utility Hooks

- `useInvalidateExecutorQueries()` — invalidates all queries (bumps version counter)
- `useRefreshInstanceConfig()` / `useRefreshSecrets()` — alias for invalidation
- `usePrefetchToolDetail()` — no-op (kept for API compat)

## File Structure

```
src/
  index.ts          # Re-exports everything
  provider.tsx      # ExecutorReactProvider + context
  hooks.ts          # All query and mutation hooks
  types.ts          # Loadable, MutationResult, legacy shim types
  use-fetch.ts      # useFetch hook + fetchJson utility
  use-mutation.ts   # useMutation hook
  index.test.tsx    # Tests against mock HTTP server
```
