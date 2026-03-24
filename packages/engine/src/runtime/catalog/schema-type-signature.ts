import * as JSONSchema from "effect/JSONSchema";

type JsonSchemaRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonSchemaRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonSchemaRecord
    : {};

const asStringArray = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 4))} ...`;

const propertyLabel = (name: string, schema: JsonSchemaRecord, optional: boolean): string =>
  `${name}${optional ? "?" : ""}: ${schemaToTypeSignature(schema)}`;

const compositeLabel = (
  key: "oneOf" | "anyOf" | "allOf",
  schema: JsonSchemaRecord,
): string | null => {
  const items = Array.isArray(schema[key]) ? schema[key].map(asRecord) : [];
  if (items.length === 0) {
    return null;
  }

  const labels = items
    .map((item) => schemaToTypeSignature(item))
    .filter((label) => label.length > 0);

  if (labels.length === 0) {
    return null;
  }

  return labels.join(key === "allOf" ? " & " : " | ");
};

export const schemaToTypeSignature = (
  input: unknown,
  maxLength: number = 220,
): string => {
  const schema = asRecord(input);

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref.trim();
    return ref.length > 0 ? ref.split("/").at(-1) ?? ref : "unknown";
  }

  if ("const" in schema) {
    return JSON.stringify(schema.const);
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  if (enumValues.length > 0) {
    return truncate(enumValues.map((value) => JSON.stringify(value)).join(" | "), maxLength);
  }

  const composite =
    compositeLabel("oneOf", schema)
    ?? compositeLabel("anyOf", schema)
    ?? compositeLabel("allOf", schema);
  if (composite) {
    return truncate(composite, maxLength);
  }

  if (schema.type === "array") {
    const itemLabel = schema.items ? schemaToTypeSignature(schema.items, maxLength) : "unknown";
    return truncate(`${itemLabel}[]`, maxLength);
  }

  if (schema.type === "object" || schema.properties) {
    const properties = asRecord(schema.properties);
    const keys = Object.keys(properties);
    if (keys.length === 0) {
      return schema.additionalProperties ? "Record<string, unknown>" : "object";
    }

    const required = new Set(asStringArray(schema.required));
    const parts = keys.map((key) =>
      propertyLabel(key, asRecord(properties[key]), !required.has(key))
    );

    return truncate(`{ ${parts.join(", ")} }`, maxLength);
  }

  if (Array.isArray(schema.type)) {
    return truncate(schema.type.join(" | "), maxLength);
  }

  if (typeof schema.type === "string") {
    return schema.type;
  }

  return "unknown";
};

export const deriveSchemaTypeSignature = (
  schema: unknown,
  maxLength?: number,
): string => {
  const schemaJson = deriveSchemaJson(schema);
  return schemaJson ? schemaToTypeSignature(schemaJson, maxLength) : "unknown";
};

export const deriveSchemaJson = (
  schema: unknown,
): JsonSchemaRecord | null => {
  try {
    return asRecord(JSONSchema.make(schema as any));
  } catch {
    return null;
  }
};
