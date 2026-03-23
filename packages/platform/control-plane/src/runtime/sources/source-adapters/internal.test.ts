import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { SourceIdSchema, WorkspaceIdSchema } from "#schema";

import { createSourceFromPayload } from "../source-definitions";
import { internalSourceAdapter } from "./internal";

describe("internal source adapter", () => {
  it("serializes and validates empty internal bindings", async () => {
    const source = await Effect.runPromise(
      createSourceFromPayload({
        workspaceId: WorkspaceIdSchema.make("ws_internal_adapter"),
        sourceId: SourceIdSchema.make("src_internal_adapter"),
        payload: {
          name: "Internal",
          kind: "internal",
          endpoint: "internal://executor",
          binding: {},
          status: "connected",
          enabled: true,
        } as never,
        now: 1234,
      }),
    );

    const serialized = internalSourceAdapter.serializeBindingConfig(source);
    expect(JSON.parse(serialized)).toEqual({
      adapterKey: "internal",
      version: 1,
      payload: {},
    });

    const validated = await Effect.runPromise(
      internalSourceAdapter.validateSource(source),
    );
    expect(validated.bindingVersion).toBe(1);
    expect(validated.binding).toEqual({});
  });

  it("rejects internal sources with HTTP binding fields", async () => {
    const source = {
      id: SourceIdSchema.make("src_internal_adapter_invalid"),
      workspaceId: WorkspaceIdSchema.make("ws_internal_adapter_invalid"),
      name: "Internal",
      kind: "internal",
      endpoint: "internal://executor",
      status: "connected",
      enabled: true,
      namespace: "internal",
      bindingVersion: 1,
      binding: {
        defaultHeaders: {
          accept: "application/json",
        },
      },
    } as never;

    const result = await Effect.runPromise(
      Effect.either(internalSourceAdapter.validateSource(source)),
    );

    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") {
      throw new Error("Expected internal source validation to fail");
    }
    expect(result.left.message).toContain(
      "internal sources cannot define HTTP source settings",
    );
  });
});
