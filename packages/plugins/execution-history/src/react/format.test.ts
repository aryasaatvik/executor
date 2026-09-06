import { describe, expect, it } from "@effect/vitest";

import { emittedRendering, outputItems, toolCallOutcome } from "./format";

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

describe("emittedRendering", () => {
  const text = (value: string) =>
    ({ type: "content", content: { type: "text", text: value } }) as const;

  it("pretty-prints a text block that carries a JSON object or array", () => {
    expect(emittedRendering(text('{"probe":"A","values":[1,2]}'))).toEqual({
      text: '{\n  "probe": "A",\n  "values": [\n    1,\n    2\n  ]\n}',
      lang: "json",
    });
    expect(emittedRendering(text("[1,2]")).lang).toBe("json");
  });

  it("shows other text verbatim, including JSON-shaped primitives", () => {
    expect(emittedRendering(text("hello"))).toEqual({ text: "hello", lang: "text" });
    // emit("123") and emit(123) are indistinguishable on the wire; never retype.
    expect(emittedRendering(text("123"))).toEqual({ text: "123", lang: "text" });
    expect(emittedRendering(text("true"))).toEqual({ text: "true", lang: "text" });
    expect(emittedRendering(text("null"))).toEqual({ text: "null", lang: "text" });
  });

  it("renders other content shapes and file references as JSON", () => {
    expect(emittedRendering({ type: "content", content: { a: 1 } })).toEqual({
      text: '{\n  "a": 1\n}',
      lang: "json",
    });
    expect(emittedRendering({ type: "file", file: { name: "x.csv" } }).lang).toBe("json");
  });
});
