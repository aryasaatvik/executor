import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

const transportAttempts: Array<string> = [];

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class StreamableHTTPClientTransport {
    readonly kind = "streamable-http";
    constructor(..._args: Array<unknown>) {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class SSEClientTransport {
    readonly kind = "sse";
    constructor(..._args: Array<unknown>) {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class Client {
    async connect(transport: { kind: string }) {
      transportAttempts.push(transport.kind);
      if (transport.kind === "streamable-http") {
        throw new Error("streamable http unavailable");
      }
    }

    async close() {
      return undefined;
    }
  },
}));

describe("createSdkMcpConnector", () => {
  beforeEach(() => {
    transportAttempts.length = 0;
  });

  it("falls back to SSE when auto transport cannot connect via streamable HTTP", async () => {
    const { createSdkMcpConnector } = await import("./connection");

    const connection = await Effect.runPromise(createSdkMcpConnector({
      endpoint: "https://example.com/mcp",
      transport: "auto",
    }));

    expect(transportAttempts).toEqual(["streamable-http", "sse"]);
    await connection.close?.();
  });
});
