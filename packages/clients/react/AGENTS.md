# executor/clients/react

React hooks and context provider for executor's engine API.

## Provider

```tsx
import { ExecutorReactProvider } from "@executor/clients/react";

<ExecutorReactProvider baseUrl="http://localhost:8788">
  {children}
</ExecutorReactProvider>
```

- Wraps app in `@effect-atom/atom-react` RegistryProvider + executor query/mutation contexts
- baseUrl defaults to `window.location.origin` in browser, `127.0.0.1:8788` in Node

## Query Hooks

Return `Loadable<T>`: `{ status: "loading" } | { status: "error", error: Error } | { status: "ready", data: T }`

| Hook | Data |
|------|------|
| `useLocalInstallation()` | `LocalInstallation` — workspace/account IDs |
| `useInstanceConfig()` | `InstanceConfig` — instance settings |
| `useSecrets()` | `ReadonlyArray<SecretListItem>` |
| `useSources()` | `ReadonlyArray<Source>` — all sources in workspace |
| `useSource(id)` | `Source` — single source by ID |
| `useSourceInspection(id)` | `SourceInspection` — tools + auth info for a source |
| `useSourceToolDetail(id, toolPath)` | `SourceInspectionToolDetail \| null` — schema for specific tool |
| `useSourceDiscovery({ sourceId, query, limit? })` | `SourceInspectionDiscoverResult` — search tools by intent |
| `useExecutions()` | `ReadonlyArray<Execution>` |
| `useExecutionSteps(executionId)` | `ReadonlyArray<ExecutionStep>` |
| `useWorkspaceOauthClients(providerKey)` | `ReadonlyArray<WorkspaceOauthClient>` |

## Mutation Hooks

Return `{ status, data, error, mutateAsync, reset }`.

| Hook | Payload | Result |
|------|---------|--------|
| `useCreateSource()` | `CreateSourcePayload` | `Source` |
| `useUpdateSource()` | `{ sourceId, payload: UpdateSourcePayload }` | `Source` |
| `useRemoveSource()` | `Source["id"]` | `{ removed: boolean }` |
| `useDiscoverSource()` | `DiscoverSourcePayload` | `SourceDiscoveryResult` |
| `useConnectSource()` | `ConnectSourcePayload` | `ConnectSourceResult` |
| `useConnectSourceBatch()` | `ConnectSourceBatchPayload` | `ConnectSourceBatchResult` |
| `useStartSourceOAuth()` | `StartSourceOAuthPayload` | `StartSourceOAuthResult` |
| `useCreateWorkspaceOauthClient()` | `CreateWorkspaceOauthClientPayload` | `WorkspaceOauthClient` |
| `useRemoveWorkspaceOauthClient()` | `WorkspaceOauthClient["id"]` | `{ removed: boolean }` |
| `useRemoveProviderAuthGrant()` | provider grant ID | `{ removed: boolean }` |
| `useCreateSecret()` | `CreateSecretPayload` | `CreateSecretResult` |
| `useUpdateSecret()` | `{ secretId, payload: UpdateSecretPayload }` | `UpdateSecretResult` |
| `useDeleteSecret()` | `secretId: string` | `DeleteSecretResult` |
| `useUpdateInstanceConfig()` | `{ semanticSearch: ... }` | `InstanceConfig` |

Mutations support optimistic updates — provide `optimisticUpdate` and `onSuccess` callbacks.

## Utility Hooks

- `useInvalidateExecutorQueries()` — invalidates all tracked queries
- `useRefreshInstanceConfig()` / `useRefreshSecrets()` — refresh specific atoms
- `usePrefetchToolDetail(sourceId, toolPath)` — prefetch and mount a tool detail atom
