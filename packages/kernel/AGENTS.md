# Kernel Workspace

## What Kernel Owns

Kernel provides the **runtime substrate** for executing agent code and the **IR (Intermediate Representation)** for describing tool APIs.

Kernel does NOT own:
- Tool registration or provisioning (control-plane)
- LLM prompting or response handling (control-plane)
- Session or execution state management (control-plane)
- Source document ingestion (importers)

## IR Layer (`ir/`)

The IR is a typed, versioned schema (`ir.v1`) describing a **catalog** of API capabilities.

Core entities:
- **CatalogV1** — top-level container: documents, resources, scopes, symbols, capabilities, executables, responseSets, diagnostics
- **Capability** — a callable surface (e.g. `github.issues.list`) with effect kind (read/write/delete/action/subscribe), auth requirements, interaction policies
- **Executable** — a binding of a capability to a protocol (HTTP adapter key + version + binding data)
- **ResponseSet** — a ranked list of response variants keyed on status codes
- **Symbol** — shapes (JSON Schema-like nodes), parameters, headers, request bodies, responses, examples, security schemes

Key projection: `projectCatalogForAgentSdk` compiles a raw catalog into `ToolDescriptor` (flat, agent-facing shape with call shape, result shape, interaction flags).

## Core Layer (`core/`)

Tool abstraction primitives:
- **ToolMap** — `Record<ToolPath, ToolDefinition>` registry
- **ToolInvoker** — `Effect<ExecuteResult>` interface for invoking tools by path with args and context
- **ToolCatalog** — queryable catalog interface (`listNamespaces`, `listTools`, `searchTools`, `getToolByPath`)
- **DiscoveryPrimitives** — `discover`, `describe`, `catalog` primitives derived from a ToolCatalog
- **makeToolInvokerFromTools** — builds a ToolInvoker from a ToolMap with input validation (Standard Schema v1), interaction policies, and elicitation hooks
- **createToolCatalogFromTools** / **mergeToolCatalogs** — build catalogs from in-memory tool registries

Interaction model:
- Tools may be `auto` (execute freely), `required` (user approval needed), or elicit additional input before execution
- `ToolInteractionPendingError` / `ToolInteractionDeniedError` are the two user-facing outcomes

## Runtimes (`runtime-*/`)

All runtimes implement the same `CodeExecutor` interface: `execute(code, toolInvoker) => Effect<ExecuteResult>`

### runtime-quickjs
Default executor. Embeds the QuickJS WebAssembly runtime in-process. No subprocess, no network. Enforces memory and stack limits. Tool calls cross the QuickJS/Effect boundary via promises. `fetch` is disabled.

### runtime-ses
SES (Secure ECMAScript) executor built on the SES shim for browsers/constrained environments. Same interface, different sandboxing model (Compartments vs. QuickJS VM).

### runtime-deno-subprocess
Executor that forks a Deno child process and communicates over stdio. Supports fetching and native Deno APIs. Higher fidelity but heavier weight. Used when the agent code needs Deno-specific capabilities.

## Ownership Boundary (Kernel vs Control-Plane)

| Concern | Owner |
|---|---|
| IR schema definitions | Kernel |
| IR validation and projection | Kernel |
| Tool invocation mechanics | Kernel |
| Interaction/elicitation hooks | Kernel (interface), Control-plane (implementation) |
| Catalog persistence/loading | Control-plane |
| Tool provisioning and registration | Control-plane |
| LLM orchestration | Control-plane |
| Execution sessions | Control-plane |
