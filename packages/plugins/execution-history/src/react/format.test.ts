import { describe, expect, it } from "@effect/vitest";

import { emittedValue, outputItems, toolCallOutcome } from "./format";

describe("toolCallOutcome", () => {
  it("passes through a recorded failure", () => {
    expect(toolCallOutcome({ status: "failed", resultJson: null, errorText: "boom" })).toEqual({
      status: "failed",
      errorText: "boom",
    });
  });

  it("derives a failure from a legacy completed row carrying a ToolResult.fail envelope", () => {
    const resultJson = JSON.stringify({
      ok: false,
      error: { code: "tool_not_found", message: "Tool not found: x.y", details: {} },
    });
    expect(toolCallOutcome({ status: "completed", resultJson, errorText: null })).toEqual({
      status: "failed",
      errorText: "tool_not_found: Tool not found: x.y",
    });
  });

  it("keeps a completed row with a success envelope or a raw value", () => {
    const ok = JSON.stringify({ ok: true, data: { id: 1 } });
    expect(toolCallOutcome({ status: "completed", resultJson: ok, errorText: null }).status).toBe(
      "completed",
    );
    expect(
      toolCallOutcome({ status: "completed", resultJson: "[1,2]", errorText: null }).status,
    ).toBe("completed");
  });
});

describe("outputItems", () => {
  it("decodes content and file items in order", () => {
    const raw = JSON.stringify([
      { type: "content", content: { a: 1 } },
      { type: "file", file: { name: "report.csv" } },
    ]);
    expect(outputItems(raw)).toEqual([
      { type: "content", content: { a: 1 } },
      { type: "file", file: { name: "report.csv" } },
    ]);
  });

  it("returns nothing for null, malformed, or unexpected shapes", () => {
    expect(outputItems(null)).toEqual([]);
    expect(outputItems("not json")).toEqual([]);
    expect(outputItems(JSON.stringify([{ type: "other" }]))).toEqual([]);
  });
});

describe("emittedValue", () => {
  it("unwraps an MCP text block carrying JSON", () => {
    const item = { type: "content", content: { type: "text", text: '{"probe":"A"}' } } as const;
    expect(emittedValue(item)).toEqual({ probe: "A" });
  });

  it("unwraps an MCP text block carrying a plain string", () => {
    const item = { type: "content", content: { type: "text", text: "hello" } } as const;
    expect(emittedValue(item)).toBe("hello");
  });

  it("leaves other content and file references untouched", () => {
    expect(emittedValue({ type: "content", content: { a: 1 } })).toEqual({ a: 1 });
    expect(emittedValue({ type: "file", file: { name: "x.csv" } })).toEqual({ name: "x.csv" });
  });
});
