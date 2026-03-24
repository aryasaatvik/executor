import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import { PolicyInsertSchema, PolicySelectSchema, PolicyUpdateSchema } from "./policy.effect-schema";

describe("policy effect schema", () => {
  it("decodes a select row that already matches the domain shape", () => {
    const decode = Schema.decodeUnknownEither(PolicySelectSchema);

    const result = decode({
      id: "pol_123",
      slug: "github-issues",
      workspaceId: "ws_123",
      resourcePattern: "github.issues.*",
      effect: "allow",
      approvalMode: "required",
      priority: 5,
      enabled: true,
      createdAt: 100,
      updatedAt: 200,
    });

    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects malformed select rows", () => {
    const decode = Schema.decodeUnknownEither(PolicySelectSchema);

    const result = decode({
      id: "pol_123",
      slug: "github-issues",
      workspaceId: "ws_123",
      resourcePattern: "github.issues.*",
      effect: "maybe",
      approvalMode: "required",
      priority: 5,
      enabled: true,
      createdAt: 100,
      updatedAt: 200,
    });

    expect(Either.isLeft(result)).toBe(true);
  });

  it("derives insert and update schemas from the same table shape", () => {
    expect(Schema.decodeUnknownEither(PolicyInsertSchema)({
      id: "pol_123",
      slug: "github-issues",
      workspaceId: "ws_123",
      resourcePattern: "github.issues.*",
      effect: "allow",
      approvalMode: "required",
      priority: 5,
      enabled: true,
      createdAt: 100,
      updatedAt: 200,
    })).toMatchObject({ _tag: "Right" });

    expect(Schema.decodeUnknownEither(PolicyUpdateSchema)({
      id: "pol_123",
      slug: "github-issues",
      workspaceId: "ws_123",
      resourcePattern: "github.issues.*",
      effect: "deny",
      approvalMode: "required",
      priority: 5,
      enabled: true,
      createdAt: 100,
      updatedAt: 300,
    })).toMatchObject({ _tag: "Right" });
  });
});
