import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { toolSchemaViewCacheKey } from "./tool-schema-view-cache";

describe("toolSchemaViewCacheKey", () => {
  it.effect("is stable for object key order and changes when schema inputs change", () =>
    Effect.gen(function* () {
      const base = {
        address: "tools.demo.org.main.inspect",
        name: "inspect",
        description: "Inspect a thing",
        inputSchema: {
          type: "object",
          properties: {
            pet: { $ref: "#/$defs/Pet" },
            owner: { type: "string" },
          },
        },
        outputSchema: { $ref: "#/$defs/Owner" },
        definitions: {
          Pet: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
          },
          Owner: { type: "object", properties: { pet: { $ref: "#/$defs/Pet" } } },
        },
      };

      const reordered = {
        ...base,
        inputSchema: {
          properties: {
            owner: { type: "string" },
            pet: { $ref: "#/$defs/Pet" },
          },
          type: "object",
        },
        definitions: {
          Owner: { properties: { pet: { $ref: "#/$defs/Pet" } }, type: "object" },
          Pet: {
            properties: {
              age: { type: "number" },
              name: { type: "string" },
            },
            type: "object",
          },
        },
      };

      const sameKey = yield* toolSchemaViewCacheKey(base);
      expect(yield* toolSchemaViewCacheKey(reordered)).toBe(sameKey);
      expect(yield* toolSchemaViewCacheKey({ ...base, description: "Changed" })).not.toBe(sameKey);
      expect(
        yield* toolSchemaViewCacheKey({
          ...base,
          definitions: {
            ...base.definitions,
            Pet: { type: "object", properties: { name: { type: "number" } } },
          },
        }),
      ).not.toBe(sameKey);
      expect(
        yield* toolSchemaViewCacheKey({
          ...base,
          inputSchema: { type: "object", properties: { pet: { type: "string" } } },
        }),
      ).not.toBe(sameKey);
    }),
  );
});
