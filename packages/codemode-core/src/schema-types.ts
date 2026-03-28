type JsonSchemaRecord = Record<string, unknown>;

export type TypeSignatureRenderOptions = {
  maxLength?: number;
  maxDepth?: number;
  maxProperties?: number;
};

const asRecord = (value: unknown): JsonSchemaRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonSchemaRecord)
    : {};

const asStringArray = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 4))} ...`;

const VALID_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const formatPropertyKey = (value: string): string =>
  VALID_IDENTIFIER_PATTERN.test(value) ? value : JSON.stringify(value);

const compositeLabel = (
  key: "oneOf" | "anyOf" | "allOf",
  schema: JsonSchemaRecord,
  render: (input: unknown) => string,
): string | null => {
  const items = Array.isArray(schema[key]) ? schema[key].map(asRecord) : [];
  if (items.length === 0) {
    return null;
  }

  const labels = items
    .map((item) => render(item))
    .filter((label) => label.length > 0);

  if (labels.length === 0) {
    return null;
  }

  return labels.join(key === "allOf" ? " & " : " | ");
};

const refSegments = (ref: string): Array<string> | null => {
  if (!ref.startsWith("#/")) {
    return null;
  }

  return ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
};

const resolveLocalRef = (
  root: JsonSchemaRecord,
  ref: string,
): JsonSchemaRecord | null => {
  const segments = refSegments(ref);
  if (!segments || segments.length === 0) {
    return null;
  }

  let current: unknown = root;
  for (const segment of segments) {
    const record = asRecord(current);
    if (!(segment in record)) {
      return null;
    }
    current = record[segment];
  }

  const resolved = asRecord(current);
  return Object.keys(resolved).length > 0 ? resolved : null;
};

const refFallbackLabel = (ref: string): string => {
  const segments = refSegments(ref);
  return segments?.at(-1) ?? ref;
};

export const schemaToTypeSignatureWithOptions = (
  input: unknown,
  options: TypeSignatureRenderOptions = {},
): string => {
  const root = asRecord(input);
  const maxLength = options.maxLength ?? 220;
  const boundedSummary = Number.isFinite(maxLength);
  const maxDepth = options.maxDepth ?? (boundedSummary ? 4 : Number.POSITIVE_INFINITY);
  const maxProperties = options.maxProperties ?? (boundedSummary ? 6 : Number.POSITIVE_INFINITY);

  const render = (
    currentInput: unknown,
    seenRefs: ReadonlySet<string>,
    depthRemaining: number,
  ): string => {
    const schema = asRecord(currentInput);

    if (depthRemaining <= 0) {
      if (typeof schema.title === "string" && schema.title.length > 0) {
        return schema.title;
      }

      if (schema.type === "array") {
        return "unknown[]";
      }

      if (schema.type === "object" || schema.properties) {
        return schema.additionalProperties ? "Record<string, unknown>" : "object";
      }
    }

    if (typeof schema.$ref === "string") {
      const ref = schema.$ref.trim();
      if (ref.length === 0) {
        return "unknown";
      }

      if (seenRefs.has(ref)) {
        return refFallbackLabel(ref);
      }

      const target = resolveLocalRef(root, ref);
      if (!target) {
        return refFallbackLabel(ref);
      }

      return render(target, new Set([...seenRefs, ref]), depthRemaining - 1);
    }

    if ("const" in schema) {
      return JSON.stringify(schema.const);
    }

    const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
    if (enumValues.length > 0) {
      return truncate(
        enumValues.map((value) => JSON.stringify(value)).join(" | "),
        maxLength,
      );
    }

    const composite =
      compositeLabel("oneOf", schema, (value) => render(value, seenRefs, depthRemaining - 1))
      ?? compositeLabel("anyOf", schema, (value) => render(value, seenRefs, depthRemaining - 1))
      ?? compositeLabel("allOf", schema, (value) => render(value, seenRefs, depthRemaining - 1));
    if (composite) {
      return truncate(composite, maxLength);
    }

    if (schema.type === "array") {
      const itemLabel = schema.items
        ? render(schema.items, seenRefs, depthRemaining - 1)
        : "unknown";
      return truncate(`${itemLabel}[]`, maxLength);
    }

    if (schema.type === "object" || schema.properties) {
      const properties = asRecord(schema.properties);
      const keys = Object.keys(properties);
      if (keys.length === 0) {
        return schema.additionalProperties ? "Record<string, unknown>" : "object";
      }

      const required = new Set(asStringArray(schema.required));
      const visibleKeys = keys.slice(0, maxProperties);
      const parts = visibleKeys.map((key) =>
        `${formatPropertyKey(key)}${required.has(key) ? "" : "?"}: ${render(properties[key], seenRefs, depthRemaining - 1)}`
      );
      if (visibleKeys.length < keys.length) {
        parts.push("...");
      }

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

  return render(root, new Set(), maxDepth);
};

export const schemaToTypeSignature = (
  input: unknown,
  maxLength: number = 220,
): string =>
  schemaToTypeSignatureWithOptions(input, { maxLength });

export const typeSignatureFromSchemaJson = (
  schemaJson: string | undefined,
  fallback: string,
  maxLength: number = 220,
): string => {
  if (!schemaJson) {
    return fallback;
  }

  try {
    return schemaToTypeSignature(JSON.parse(schemaJson) as unknown, maxLength);
  } catch {
    return fallback;
  }
};

export const typeSignatureFromSchema = (
  schema: unknown,
  fallback: string,
  maxLength: number = 220,
): string => {
  if (schema === undefined) {
    return fallback;
  }

  try {
    return schemaToTypeSignature(schema, maxLength);
  } catch {
    return fallback;
  }
};

export const typeSignatureFromSchemaWithOptions = (
  schema: unknown,
  fallback: string,
  options: TypeSignatureRenderOptions = {},
): string => {
  if (schema === undefined) {
    return fallback;
  }

  try {
    return schemaToTypeSignatureWithOptions(schema, options);
  } catch {
    return fallback;
  }
};
