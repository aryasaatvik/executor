import { describe, expect, it } from "@effect/vitest";

import { typeSignatureFromSchema } from "./schema-types";

describe("schema-types", () => {
  it("expands local $defs refs in type signatures", () => {
    const schema = {
      type: "object",
      properties: {
        args: {
          type: "object",
          properties: {
            input: {
              $ref: "#/$defs/input",
            },
          },
          required: ["input"],
          additionalProperties: false,
        },
      },
      required: ["args"],
      additionalProperties: false,
      $defs: {
        input: {
          type: "object",
          properties: {
            issueId: {
              type: "string",
            },
            externalLink: {
              type: "string",
            },
          },
          required: ["issueId"],
          additionalProperties: false,
        },
      },
    };

    expect(typeSignatureFromSchema(schema, "unknown", Infinity)).toBe(
      "{ args: { input: { issueId: string, externalLink?: string } } }",
    );
  });

  it("renders GraphQL error arrays with object item shapes", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
            },
          },
          required: ["success"],
          additionalProperties: false,
        },
        errors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              message: {
                type: "string",
              },
            },
            required: ["message"],
            additionalProperties: true,
          },
        },
      },
      required: ["data", "errors"],
      additionalProperties: false,
    };

    expect(typeSignatureFromSchema(schema, "unknown", Infinity)).toContain(
      "errors: { message: string }[]",
    );
  });

  it("quotes invalid object property names", () => {
    const schema = {
      type: "object",
      properties: {
        "x-request-id": {
          type: "string",
        },
      },
      required: ["x-request-id"],
      additionalProperties: false,
    };

    expect(typeSignatureFromSchema(schema, "unknown", Infinity)).toBe(
      '{ "x-request-id": string }',
    );
  });
});
