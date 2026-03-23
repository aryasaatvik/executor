# executor/hosts

Two host integrations: MCP server bridge and AI SDK adapter.

## MCP Server (`packages/hosts/mcp`)

Exposes executor as a [Model Context Protocol](https://modelcontextprotocol.io/) server over HTTP(S).

### Entry point

```ts
import { createExecutorMcpRequestHandler } from "@executor/hosts/mcp";
import type { ControlPlaneRuntime } from "@executor/control-plane";

const handler = createExecutorMcpRequestHandler(runtime: ControlPlaneRuntime);
// handler.handleRequest(req: Request) => Promise<Response>
// handler.close() => Promise<void>
```

### Tools exposed

| Tool | Input | Description |
|------|-------|-------------|
| `execute` | `{ code: string }` | Run TypeScript in sandbox; call tools via discovery workflow. Returns execution result or `resumePayload` if paused for interaction. |
| `resume` | `{ resumePayload: { executionId }, response?: { action: "accept" \| "decline" \| "cancel", content? } }` | Resume a paused execution. Use after user approves or declines an interaction. |
| `tool_search` | `{ query: string, max_results?: number, source?: string, include_schemas?: boolean }` | Search workspace tool catalog by intent or exact path (`+github.issues.create`). |

### Interaction model

When `execute` pauses for user interaction:
- If MCP client supports managed elicitation (`elicitation.form` + `elicitation.url`), the server uses `server.elicitInput()` to prompt directly and auto-resumes.
- Otherwise, returns `structuredContent.interaction` with `resumePayload`; caller must call `resume` with user decision.

Sessions are tracked via `mcp-session-id` header. Transport: `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`.

---

## AI SDK Adapter (`packages/hosts/ai-sdk`)

Wraps executor as [Vercel AI SDK](https://sdk.vercel.ai/) tools.

### Entry points

```ts
import {
  createCodeTool,           // single tool: executor as one AI SDK tool
  createToolsFromAiSdkTools, // convert existing AI SDK ToolSet to executor ToolMap
  CodeToolInputSchema,       // Zod schema: { code: string }
} from "@executor/hosts/ai-sdk";
```

### `createCodeTool`

```ts
const executorTool = createCodeTool({
  toolInvoker,   // ToolInvoker from @executor/codemode-core
  executor,     // CodeExecutor from @executor/codemode-core
  description?, // optional override
});
// Returns an AI SDK `tool` — pass to AI SDK's `generateText` or `streamText`
```

### `createToolsFromAiSdkTools`

```ts
const toolMap = createToolsFromAiSdkTools({
  tools: aiSdkTools,  // Record<string, AI SDK tool>
  sourceKey?,         // optional source key for executor
});
// Returns a ToolMap compatible with executor's runtime
```

Intended for round-tripping: AI SDK tools → executor tool discovery → AI SDK tool execution.
