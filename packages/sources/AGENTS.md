# Sources Workspace

Source adapters bridge external tool sources (MCP servers, OpenAPI specs, GraphQL endpoints) into the executor tool catalog.

## Core Abstraction: SourceAdapter

Every adapter implements `SourceAdapter` (core/src/types.ts):

```
SourceAdapter {
  key: string                           // unique adapter id ("mcp", "openapi")
  displayName: string
  catalogKind: SourceCatalogKind
  connectStrategy: "direct" | "interactive" | "none"
  credentialStrategy: "credential_managed" | "adapter_defined" | "none"

  // Provider and auth
  providerKey: string
  defaultImportAuthPolicy: SourceImportAuthPolicy

  // Binding config: serialize/deserialize per-source transport settings
  bindingConfigVersion: number
  serializeBindingConfig: (source) => string
  deserializeBindingConfig: (record) => Effect<StoredSourceBindingConfig>
  bindingStateFromSource: (source) => Effect<SourceBindingState>
  sourceConfigFromSource: (source) => Record<string, unknown>

  // Schema for "add source" UI
  connectPayloadSchema: Schema | null
  executorAddInputSchema: Schema | null
  executorAddHelpText: readonly string[] | null
  executorAddInputSignatureWidth: number | null

  // Local config binding
  localConfigBindingSchema: Schema | null
  localConfigBindingFromSource: (source) => unknown

  // Validation
  validateSource: (source) => Effect<Source>

  // Auto-detection
  shouldAutoProbe: (source) => boolean
  detectSource?: (input) => Effect<SourceDiscoveryResult | null>
  discoveryPriority?: ({ normalizedUrl }) => number

  // Tool discovery — fetches tools from source and returns catalog fragment
  syncCatalog: (input: SourceAdapterSyncInput) => Effect<SourceCatalogSyncResult>

  // Tool invocation
  invoke: (input: SourceAdapterInvokeInput) => Effect<SourceAdapterInvokeResult>

  // OAuth2 (optional)
  getOauth2SetupConfig?: (input: { source: Source; slot: CredentialSlot }) => Effect<OAuth2SetupConfig | null>
  normalizeOauthClientInput?: (input: SourceOauthClientInput) => Effect<NormalizedOAuthClientInput>
}
```

## Core Data Types (core/src/source-models.ts)

- `Source` — stored source config: endpoint, auth, binding (transport settings), status
- `SourceBinding` — versioned binding config payload (e.g., transport type, command/args for stdio, headers)
- `SourceCatalogSyncResult` — result of syncCatalog containing a `CatalogFragment`
- `CatalogFragment` — collection of tool operations discovered from a source

## SourceAdapterRegistry (core/src/registry.ts)

```ts
createSourceAdapterRegistry([mcpAdapter, openApiAdapter, ...])
// Provides: getSourceAdapter(key), getSourceAdapterForSource(source),
//           findSourceAdapterByProviderKey(providerKey), etc.
```

## Sync Flow (How Tools Get Registered)

1. Control plane calls `adapter.syncCatalog({ source, resolveAuthMaterialForSlot })`
2. Adapter fetches tool manifest from source (e.g., MCP list_tools, OpenAPI spec URL)
3. Adapter transforms manifest into `CatalogFragment` (operations with input/output schemas, providerData)
4. Fragment is merged into the workspace catalog
5. Tools are now available for invocation

## Invoke Flow (How Tools Execute)

1. Control plane routes to `adapter.invoke({ source, capability, executable, args, auth, context })`
2. Adapter reads binding config from `source.binding` (transport, headers, command, etc.)
3. Adapter constructs HTTP request or MCP invocation
4. Auth material (headers, cookies, query params) resolved via `auth` placements
5. Adapter returns `SourceAdapterInvokeResult { data, error, headers, status }`

## Adapters

### mcp/ — MCP Server Adapter
- key: `"mcp"`, connectStrategy: `"interactive"`, credentialStrategy: `"adapter_defined"`
- Transport: stdio (command+args+env) or HTTP (streamable-http, sse)
- `syncCatalog`: calls `list_tools` via MCP connector
- `invoke`: pooled MCP connector, executes tool via MCP protocol
- Files: adapter.ts, connection.ts, connection-pool.ts, tools.ts, catalog.ts

### openapi/ — OpenAPI Adapter
- key: `"openapi"`, connectStrategy: `"direct"`, credentialStrategy: `"credential_managed"`
- Binding: specUrl (OpenAPI document URL) + defaultHeaders
- `syncCatalog`: fetches and parses OpenAPI spec, compiles to tool definitions
- `invoke`: builds HTTP request from OpenAPI operation (path params, query, headers, body)
- Files: adapter.ts, document.ts, extraction.ts, tools.ts, catalog.ts, http-serialization.ts

## Key Files

- core/src/types.ts — SourceAdapter interface
- core/src/registry.ts — SourceAdapterRegistry
- core/src/source-models.ts — Source, SourceBinding, SourceAuth types
- core/src/catalog.ts / catalog-fragment.ts — CatalogFragment builder
- core/src/discovery.ts — HTTP probe utilities, URL normalization, auth inference
- mcp/src/adapter.ts — MCP adapter implementation
- openapi/src/adapter.ts — OpenAPI adapter implementation

## Schema Conventions

- Effect/Schema used for all binding config serialization
- Input/output schemas for tools are stored in CatalogFragment operations
- Auth placements resolved at invoke time (not stored in binding)
