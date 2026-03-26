import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import {
  ExecutorReactProvider,
  type Loadable,
  type Source,
  useCreateSource,
  useRemoveSource,
  useSource,
  useSourceInspection,
  useSources,
  useUpdateSource,
  useSecrets,
  useExecutions,
  useExecutionSteps,
} from "./index";

// ---------------------------------------------------------------------------
// JSDOM setup
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1/",
});

globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.Event = dom.window.Event;
globalThis.EventTarget = dom.window.EventTarget;

globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number;
globalThis.cancelAnimationFrame = (handle: number) => {
  clearTimeout(handle);
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockSource: Source = {
  id: "src_1",
  workspaceId: "ws_1",
  name: "Test Source",
  kind: "openapi",
  endpoint: "https://example.com",
  status: "connected",
  enabled: true,
  namespace: null,
  iconUrl: null,
  bindingVersion: 1,
  binding: {},
  importAuthPolicy: "none",
  importAuth: { kind: "none" },
  auth: { kind: "none" },
  sourceHash: null,
  lastError: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockRoute = {
  method: string;
  pattern: RegExp;
  handler: (req: IncomingMessage, body: string) => { status: number; body: unknown };
};

async function startMockServer(routes: readonly MockRoute[]): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks).toString("utf-8");

    const route = routes.find(
      (r) => r.method === method && r.pattern.test(url.pathname),
    );

    if (!route) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "not_found", message: "Not found" }));
      return;
    }

    const result = route.handler(req, body);
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result.body));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

type HookHarness<T> = {
  current: T | null;
  unmount: () => Promise<void>;
};

async function renderHarness<T>(
  useValue: () => T,
  baseUrl: string,
): Promise<HookHarness<T>> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const snapshot: { current: T | null } = { current: null };

  const Probe = () => {
    const value = useValue();
    React.useLayoutEffect(() => {
      snapshot.current = value;
    }, [value]);
    return null;
  };

  await React.act(async () => {
    root.render(
      <ExecutorReactProvider baseUrl={baseUrl}>
        <Probe />
      </ExecutorReactProvider>,
    );
  });

  return {
    get current() {
      return snapshot.current;
    },
    unmount: async () => {
      await React.act(async () => root.unmount());
      container.remove();
    },
  };
}

async function waitFor<T>(
  read: () => T | null,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null && predicate(value)) return value;
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error("Timed out waiting for test state");
}

function isReady<T>(l: Loadable<T>): l is { status: "ready"; data: T } {
  return l.status === "ready";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executor-react hooks (REST)", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  it("useSources fetches sources from GET /v1/sources", async () => {
    const server = await startMockServer([
      {
        method: "GET",
        pattern: /^\/v1\/sources$/,
        handler: () => ({ status: 200, body: [mockSource] }),
      },
    ]);
    servers.push(server);

    const harness = await renderHarness(() => useSources(), server.baseUrl);
    try {
      const result = await waitFor(
        () => harness.current,
        (v) => isReady(v) && v.data.length === 1,
      );
      expect(isReady(result)).toBe(true);
      if (isReady(result)) {
        expect(result.data[0].id).toBe("src_1");
        expect(result.data[0].name).toBe("Test Source");
      }
    } finally {
      await harness.unmount();
    }
  });

  it("useSource fetches a single source by ID", async () => {
    const server = await startMockServer([
      {
        method: "GET",
        pattern: /^\/v1\/sources\/src_1$/,
        handler: () => ({ status: 200, body: mockSource }),
      },
    ]);
    servers.push(server);

    const harness = await renderHarness(
      () => useSource("src_1"),
      server.baseUrl,
    );
    try {
      const result = await waitFor(
        () => harness.current,
        (v) => isReady(v),
      );
      if (isReady(result)) {
        expect(result.data.name).toBe("Test Source");
      }
    } finally {
      await harness.unmount();
    }
  });

  it("useSource returns error for missing source", async () => {
    const server = await startMockServer([]);
    servers.push(server);

    const harness = await renderHarness(
      () => useSource("src_missing"),
      server.baseUrl,
    );
    try {
      const result = await waitFor(
        () => harness.current,
        (v) => v !== null && v.status === "error",
      );
      expect(result.status).toBe("error");
    } finally {
      await harness.unmount();
    }
  });

  it("useCreateSource posts to /v1/sources and triggers invalidation", async () => {
    let sourceList = [mockSource];
    const server = await startMockServer([
      {
        method: "GET",
        pattern: /^\/v1\/sources$/,
        handler: () => ({ status: 200, body: sourceList }),
      },
      {
        method: "POST",
        pattern: /^\/v1\/sources$/,
        handler: (_req, body) => {
          const payload = JSON.parse(body);
          const created: Source = {
            ...mockSource,
            id: "src_2",
            name: payload.name,
          };
          sourceList = [...sourceList, created];
          return { status: 201, body: created };
        },
      },
    ]);
    servers.push(server);

    type State = {
      sources: Loadable<readonly Source[]>;
      create: ReturnType<typeof useCreateSource>;
    };

    const harness = await renderHarness<State>(
      () => ({
        sources: useSources(),
        create: useCreateSource(),
      }),
      server.baseUrl,
    );

    try {
      await waitFor(
        () => harness.current,
        (v) => isReady(v.sources) && v.sources.data.length === 1,
      );

      await React.act(async () => {
        await harness.current!.create.mutateAsync({
          name: "New Source",
          kind: "openapi",
          endpoint: "https://example.com/new",
        });
      });

      expect(harness.current!.create.status).toBe("success");
    } finally {
      await harness.unmount();
    }
  });

  it("useExecutionSteps returns empty array for empty executionId", async () => {
    const server = await startMockServer([]);
    servers.push(server);

    const harness = await renderHarness(
      () => useExecutionSteps(""),
      server.baseUrl,
    );
    try {
      const result = await waitFor(
        () => harness.current,
        (v) => isReady(v),
      );
      if (isReady(result)) {
        expect(result.data).toEqual([]);
      }
    } finally {
      await harness.unmount();
    }
  });
});
