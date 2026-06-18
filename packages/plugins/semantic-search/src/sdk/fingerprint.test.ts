import { describe, expect, it } from "@effect/vitest";

import { fingerprintTool } from "./fingerprint";

const base = {
  path: "github.repos.get",
  name: "repos.get",
  description: "Get a GitHub repository by owner and name.",
  inputSchema: {
    type: "object",
    properties: { owner: { type: "string" }, repo: { type: "string" } },
  },
  outputSchema: {
    type: "object",
    properties: { id: { type: "number" }, full_name: { type: "string" } },
  },
} as const;

describe("fingerprintTool", () => {
  it("is deterministic — same input yields the same hash", () => {
    const a = fingerprintTool(base);
    const b = fingerprintTool({ ...base });
    expect(a).toBe(b);
  });

  it("changes when description changes", () => {
    const original = fingerprintTool(base);
    const changed = fingerprintTool({ ...base, description: "Updated description." });
    expect(changed).not.toBe(original);
  });

  it("changes when inputSchema changes", () => {
    const original = fingerprintTool(base);
    const changed = fingerprintTool({
      ...base,
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          ref: { type: "string" },
        },
      },
    });
    expect(changed).not.toBe(original);
  });

  it("changes when outputSchema changes", () => {
    const original = fingerprintTool(base);
    const changed = fingerprintTool({
      ...base,
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          full_name: { type: "string" },
          private: { type: "boolean" },
        },
      },
    });
    expect(changed).not.toBe(original);
  });

  it("changes when a referenced $def changes (def-only change)", () => {
    const withDef = fingerprintTool({
      ...base,
      schemaDefinitions: { Repo: { type: "object", properties: { id: { type: "number" } } } },
    });
    const changedDef = fingerprintTool({
      ...base,
      schemaDefinitions: { Repo: { type: "object", properties: { id: { type: "string" } } } },
    });
    expect(changedDef).not.toBe(withDef);
  });

  it("is canonical — schema key order does not change the hash", () => {
    const reordered = fingerprintTool({
      ...base,
      inputSchema: {
        properties: { repo: { type: "string" }, owner: { type: "string" } },
        type: "object",
      },
    });
    expect(reordered).toBe(fingerprintTool(base));
  });

  it("changes when path changes", () => {
    const original = fingerprintTool(base);
    const changed = fingerprintTool({ ...base, path: "github.repos.list" });
    expect(changed).not.toBe(original);
  });

  it("changes when name changes", () => {
    const original = fingerprintTool(base);
    const changed = fingerprintTool({ ...base, name: "repos.list" });
    expect(changed).not.toBe(original);
  });

  it("two different tools produce different hashes", () => {
    const tool1 = fingerprintTool(base);
    const tool2 = fingerprintTool({
      path: "github.issues.create",
      name: "issues.create",
      description: "Create an issue in a repository.",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
      outputSchema: { type: "object", properties: { id: { type: "number" } } },
    });
    expect(tool1).not.toBe(tool2);
  });

  it("does not blur field boundaries — shifting content across fields changes the hash", () => {
    // Under a space separator these collide ("a" + " " + "b c" === "a b" + " " + "c");
    // the NUL separator keeps the boundary distinct.
    const a = fingerprintTool({ path: "a", name: "b c" });
    const b = fingerprintTool({ path: "a b", name: "c" });
    expect(a).not.toBe(b);
  });

  it("treats absent optional fields the same as empty content", () => {
    const withEmpty = fingerprintTool({
      path: "x.y",
      name: "y",
      description: "",
    });
    const withAbsent = fingerprintTool({
      path: "x.y",
      name: "y",
    });
    expect(withEmpty).toBe(withAbsent);
  });
});
