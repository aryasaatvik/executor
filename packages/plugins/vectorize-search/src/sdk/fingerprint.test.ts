import { describe, expect, it } from "@effect/vitest";

import { fingerprintTool } from "./fingerprint";

const base = {
  path: "github.repos.get",
  name: "repos.get",
  description: "Get a GitHub repository by owner and name.",
  inputTypeScript: "{ owner: string; repo: string }",
  outputTypeScript: "{ id: number; full_name: string }",
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

  it("changes when inputTypeScript changes", () => {
    const original = fingerprintTool(base);
    const changed = fingerprintTool({
      ...base,
      inputTypeScript: "{ owner: string; repo: string; ref?: string }",
    });
    expect(changed).not.toBe(original);
  });

  it("changes when outputTypeScript changes", () => {
    const original = fingerprintTool(base);
    const changed = fingerprintTool({
      ...base,
      outputTypeScript: "{ id: number; full_name: string; private: boolean }",
    });
    expect(changed).not.toBe(original);
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
      inputTypeScript: "{ title: string; body?: string }",
      outputTypeScript: "{ id: number; number: number }",
    });
    expect(tool1).not.toBe(tool2);
  });

  it("treats absent optional fields the same as empty strings", () => {
    const withEmpty = fingerprintTool({
      path: "x.y",
      name: "y",
      description: "",
      inputTypeScript: "",
      outputTypeScript: "",
    });
    const withAbsent = fingerprintTool({
      path: "x.y",
      name: "y",
    });
    expect(withEmpty).toBe(withAbsent);
  });
});
