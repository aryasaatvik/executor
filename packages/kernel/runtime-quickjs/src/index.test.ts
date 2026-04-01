import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  allowAllToolInteractions,
  makeToolInvokerFromTools,
  toExecutorTool,
} from "@executor/codemode-core";

import { makeQuickJsExecutor } from "./index";

const numberPairInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    a: Schema.Number,
    b: Schema.Number,
  }),
);

const messageInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    message: Schema.String,
  }),
);

const discoverInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
  }),
);

const describeToolInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    path: Schema.String,
    includeSchemas: Schema.optional(Schema.Boolean),
  }),
);

const repoInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    owner: Schema.String,
    repo: Schema.String,
  }),
);

const tools = {
  "math.add": {
    description: "Add two numbers",
    inputSchema: numberPairInputSchema,
    execute: ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
  },
  "notifications.send": toExecutorTool({
    tool: {
      description: "Send a message",
      inputSchema: messageInputSchema,
      execute: ({ message }: { message: string }) => ({
        delivered: true,
        message,
      }),
    },
    metadata: {
      interaction: "required",
    },
  }),
};

describe("runtime-quickjs", () => {
  it.effect("executes simple code and returns result", () =>
    Effect.gen(function* () {
      const executor = makeQuickJsExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executor.execute(
        "return 1 + 2;",
        toolInvoker,
      );

      expect(output.result).toBe(3);
      expect(output.error).toBeUndefined();
    }),
  );

  it.effect("executes code with tool calls", () =>
    Effect.gen(function* () {
      const executor = makeQuickJsExecutor();
      const toolInvoker = makeToolInvokerFromTools({
        tools,
        onToolInteraction: allowAllToolInteractions,
      });

      const output = yield* executor.execute(
        [
          "const math = await tools.math.add({ a: 19, b: 23 });",
          "await tools.notifications.send({ message: `sum is ${math.sum}` });",
          "return math;",
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toEqual({ sum: 42 });
      expect(output.error).toBeUndefined();
    }),
  );

  it.effect("captures console output in logs", () =>
    Effect.gen(function* () {
      const executor = makeQuickJsExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executor.execute(
        [
          'console.log("hello from quickjs");',
          'console.warn("a warning");',
          'console.error("an error");',
          "return 42;",
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toBe(42);
      expect(output.logs).toContain("[log] hello from quickjs");
      expect(output.logs).toContain("[warn] a warning");
      expect(output.logs).toContain("[error] an error");
    }),
  );

  it.effect("reports execution errors without crashing", () =>
    Effect.gen(function* () {
      const executor = makeQuickJsExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executor.execute(
        'throw new Error("boom");',
        toolInvoker,
      );

      expect(output.result).toBeNull();
      expect(output.error).toContain("boom");
    }),
  );

  it.effect("handles tool call errors gracefully", () =>
    Effect.gen(function* () {
      const failingTools = {
        "broken.thing": {
          description: "Always fails",
          inputSchema: Schema.standardSchemaV1(Schema.Struct({})),
          execute: () => {
            throw new Error("tool is broken");
          },
        },
      };

      const executor = makeQuickJsExecutor();
      const toolInvoker = makeToolInvokerFromTools({
        tools: failingTools,
      });

      const output = yield* executor.execute(
        "return await tools.broken.thing({});",
        toolInvoker,
      );

      expect(output.result).toBeNull();
      expect(output.error).toContain("tool is broken");
    }),
  );

  it.effect("respects timeout", () =>
    Effect.gen(function* () {
      const executor = makeQuickJsExecutor({
        timeoutMs: 250,
      });
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executor.execute(
        "while (true) {}",
        toolInvoker,
      );

      expect(output.result).toBeNull();
      expect(output.error).toContain("timed out");
    }),
  );

  it.effect("network access is denied by default", () =>
    Effect.gen(function* () {
      const executor = makeQuickJsExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executor.execute(
        'await fetch("https://example.com"); return 1;',
        toolInvoker,
      );

      expect(output.result).toBeNull();
      expect(output.error).toContain("fetch is disabled in QuickJS executor");
    }),
  );

  it.effect("multiple sequential tool calls work correctly", () =>
    Effect.gen(function* () {
      const executor = makeQuickJsExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executor.execute(
        [
          "const r1 = await tools.math.add({ a: 1, b: 2 });",
          "const r2 = await tools.math.add({ a: r1.sum, b: 10 });",
          "const r3 = await tools.math.add({ a: r2.sum, b: 100 });",
          "return r3;",
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toEqual({ sum: 113 });
      expect(output.error).toBeUndefined();
    }),
  );

  it.effect("does not expose internal executor bridge globals to user code", () =>
    Effect.gen(function* () {
      const executor = makeQuickJsExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executor.execute(
        [
          "return {",
          "  hasInvokeTool: typeof globalThis.__executor_invokeTool !== 'undefined',",
          "  hasLogBridge: typeof globalThis.__executor_log !== 'undefined',",
          "  globalKeys: Object.keys(globalThis).sort(),",
          "};",
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toEqual({
        hasInvokeTool: false,
        hasLogBridge: false,
        globalKeys: [],
      });
      expect(output.error).toBeUndefined();
    }),
  );

  it.effect("supports the documented discovery workflow shape", () =>
    Effect.gen(function* () {
      const executor = makeQuickJsExecutor();
      const toolInvoker = makeToolInvokerFromTools({
        tools: {
          discover: {
            inputSchema: discoverInputSchema,
            execute: () => ({
              bestPath: "github.issues.list",
              results: [
                {
                  path: "github.issues.list",
                  score: 0.99,
                },
              ],
              total: 1,
            }),
          },
          "describe.tool": {
            inputSchema: describeToolInputSchema,
            execute: ({ path }: { path: string; includeSchemas?: boolean }) => ({
              path,
              contract: {
                inputTypePreview: "{ owner: string; repo: string }",
              },
            }),
          },
          "github.issues.list": {
            inputSchema: repoInputSchema,
            execute: ({ owner, repo }: { owner: string; repo: string }) => ({
              owner,
              repo,
              issues: [{ id: "issue_1" }],
            }),
          },
        },
      });

      const output = yield* executor.execute(
        [
          'const { results, bestPath } = await tools.discover({ query: "github issues", limit: 5 });',
          "const path = bestPath ?? results[0]?.path;",
          'if (!path) throw new Error("No matching tools found.");',
          "const detail = await tools.describe.tool({ path, includeSchemas: true });",
          'const issues = await tools.github.issues.list({ owner: "openai", repo: "codex" });',
          "return { path, detail, issues };",
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toEqual({
        path: "github.issues.list",
        detail: {
          path: "github.issues.list",
          contract: {
            inputTypePreview: "{ owner: string; repo: string }",
          },
        },
        issues: {
          owner: "openai",
          repo: "codex",
          issues: [{ id: "issue_1" }],
        },
      });
      expect(output.error).toBeUndefined();
    }),
  );
});
