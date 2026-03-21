import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { handleToolSearch } from "./tool-search";
import type {
  SearchHit,
  ToolCatalog,
  ToolDescriptor,
  ToolPath,
  ToolNamespace,
} from "@executor/codemode-core";

const githubIssueTool: ToolDescriptor = {
  path: "github.issues.create" as ToolPath,
  sourceKey: "github",
  description: "Create a GitHub issue",
  contract: {
    inputTypePreview: "{ owner: string; repo: string; title: string }",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
      },
    },
  },
};

const slackMessageTool: ToolDescriptor = {
  path: "slack.messages.send" as ToolPath,
  sourceKey: "slack",
  description: "Send a Slack message",
  contract: {
    inputTypePreview: "{ channel: string; text: string }",
  },
};

function makeCatalog(overrides?: {
  searchHits?: readonly SearchHit[];
  toolsByPath?: Record<string, ToolDescriptor | null>;
}): ToolCatalog {
  const toolsByPath = overrides?.toolsByPath ?? {
    [githubIssueTool.path]: githubIssueTool,
    [slackMessageTool.path]: slackMessageTool,
  };

  return {
    listNamespaces: () => Effect.succeed([] as readonly ToolNamespace[]),
    listTools: () => Effect.succeed([] as readonly ToolDescriptor[]),
    getToolByPath: ({ path }) =>
      Effect.succeed((toolsByPath[path] ?? null) as ToolDescriptor | null),
    searchTools: () =>
      Effect.succeed(
        overrides?.searchHits
          ?? ([
            { path: githubIssueTool.path, score: 0.9 },
            { path: slackMessageTool.path, score: 0.6 },
          ] as const),
      ),
  };
}

describe("tool_search", () => {
  it("trims exact lookups after + and returns the matching tool", async () => {
    const result = await Effect.runPromise(
      handleToolSearch(makeCatalog(), {
        query: "+ github.issues.create ",
        include_schemas: true,
      }),
    );

    expect(result.meta.mode).toBe("exact");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.path).toBe("github.issues.create");
    expect(result.results[0]?.input_schema).toEqual(githubIssueTool.contract?.inputSchema);
  });

  it("treats bare + exact lookups as empty results", async () => {
    const result = await Effect.runPromise(
      handleToolSearch(makeCatalog(), {
        query: "+",
      }),
    );

    expect(result.meta.mode).toBe("exact");
    expect(result.results).toEqual([]);
  });

  it("applies the source filter to hydrated search results", async () => {
    const result = await Effect.runPromise(
      handleToolSearch(makeCatalog(), {
        query: "create message",
        source: "slack",
        max_results: 10,
      }),
    );

    expect(result.meta.mode).toBe("search");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.path).toBe("slack.messages.send");
  });

  it("applies the source filter to exact lookups", async () => {
    const result = await Effect.runPromise(
      handleToolSearch(makeCatalog(), {
        query: "+github.issues.create",
        source: "slack",
      }),
    );

    expect(result.results).toEqual([]);
  });
});
