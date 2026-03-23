import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import {
  clearAllMcpConnectionPools,
  clearMcpConnectionPoolRun,
  createPooledMcpConnector,
} from "./connection-pool";
import type { McpConnection, McpConnector } from "./tools";

const makeConnection = (input: {
  label: string;
  connectCount: { value: number };
  closeCount: { value: number };
}): McpConnection => ({
  client: {
    listTools: async () => [],
    callTool: async () => ({ label: input.label }),
  },
  close: async () => {
    input.closeCount.value += 1;
  },
});

const makeAsyncConnector = (input: {
  label: string;
  connectCount: { value: number };
  closeCount: { value: number };
}): McpConnector =>
  Effect.tryPromise({
    try: async () => {
      input.connectCount.value += 1;
      await Promise.resolve();
      return makeConnection(input);
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

describe("createPooledMcpConnector", () => {
  beforeEach(async () => {
    await Effect.runPromise(clearAllMcpConnectionPools());
  });

  afterEach(async () => {
    await Effect.runPromise(clearAllMcpConnectionPools());
  });

  it("reuses the same pooled connection for repeated run-scoped access", async () => {
    const connectCount = { value: 0 };
    const closeCount = { value: 0 };
    const connect = makeAsyncConnector({
      label: "run-1",
      connectCount,
      closeCount,
    });

    const connector = createPooledMcpConnector({
      connect,
      runId: "run-1",
      sourceKey: "source-1",
    });

    const first = await Effect.runPromise(connector);
    const second = await Effect.runPromise(connector);

    expect(connectCount.value).toBe(1);
    expect(first.client).toBe(second.client);
    expect(closeCount.value).toBe(0);

    await Effect.runPromise(clearMcpConnectionPoolRun("run-1"));

    expect(closeCount.value).toBe(1);
  });

  it("invalidates a session-scoped connection and recreates it on the next access", async () => {
    const connectCount = { value: 0 };
    const closeCount = { value: 0 };
    const connect = makeAsyncConnector({
      label: "session-1",
      connectCount,
      closeCount,
    });

    const connector = createPooledMcpConnector({
      connect,
      sessionOwner: {
        workspaceId: "workspace-1",
        accountId: "account-1",
        executionSessionId: "session-1",
      },
      sourceKey: "source-1",
    });

    const first = await Effect.runPromise(connector);
    expect(connectCount.value).toBe(1);

    await first.invalidate?.();
    expect(closeCount.value).toBe(1);

    const second = await Effect.runPromise(connector);
    expect(second.client).not.toBe(first.client);
    expect(connectCount.value).toBe(2);

    await Effect.runPromise(clearAllMcpConnectionPools());
    expect(closeCount.value).toBe(2);
  });

  it("closes pooled connections when clearing all pools", async () => {
    const runConnectCount = { value: 0 };
    const sessionConnectCount = { value: 0 };
    const runCloseCount = { value: 0 };
    const sessionCloseCount = { value: 0 };

    const runConnector = createPooledMcpConnector({
      connect: makeAsyncConnector({
        label: "run-clear",
        connectCount: runConnectCount,
        closeCount: runCloseCount,
      }),
      runId: "run-clear",
      sourceKey: "source-run",
    });
    const sessionConnector = createPooledMcpConnector({
      connect: makeAsyncConnector({
        label: "session-clear",
        connectCount: sessionConnectCount,
        closeCount: sessionCloseCount,
      }),
      sessionOwner: {
        workspaceId: "workspace-clear",
        accountId: "account-clear",
        executionSessionId: "session-clear",
      },
      sourceKey: "source-session",
    });

    await Effect.runPromise(runConnector);
    await Effect.runPromise(sessionConnector);
    await Effect.runPromise(clearAllMcpConnectionPools());

    expect(runConnectCount.value).toBe(1);
    expect(sessionConnectCount.value).toBe(1);
    expect(runCloseCount.value).toBe(1);
    expect(sessionCloseCount.value).toBe(1);
  });
});
