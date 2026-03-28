export type HttpRequestPlacements = {
  headers?: Readonly<Record<string, string>>;
  queryParams?: Readonly<Record<string, string>>;
  cookies?: Readonly<Record<string, string>>;
  bodyValues?: Readonly<Record<string, string>>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeJsonPointerSegment = (value: string): string =>
  value.replaceAll("~1", "/").replaceAll("~0", "~");

const pathSegmentsFromPlacementPath = (value: string): ReadonlyArray<string> => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith("/")) {
    return trimmed
      .split("/")
      .slice(1)
      .map(decodeJsonPointerSegment)
      .filter((segment) => segment.length > 0);
  }

  return trimmed.split(".").filter((segment) => segment.length > 0);
};

const findHeaderKey = (
  headers: Readonly<Record<string, string>>,
  name: string,
): string | null => {
  const lowered = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) {
      return key;
    }
  }

  return null;
};

const parseCookieHeader = (value: string): Record<string, string> => {
  const parsed: Record<string, string> = {};

  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      parsed[trimmed] = "";
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const cookieValue = trimmed.slice(separatorIndex + 1).trim();
    if (name.length > 0) {
      parsed[name] = cookieValue;
    }
  }

  return parsed;
};

const setNestedRecordValue = (
  target: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: string,
) => {
  let current = target;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const next = current[segment];
    if (isRecord(next)) {
      current = next;
      continue;
    }

    const replacement: Record<string, unknown> = {};
    current[segment] = replacement;
    current = replacement;
  }

  current[path[path.length - 1]!] = value;
};

export const applyHttpQueryPlacementsToUrl = (input: {
  url: string | URL;
  queryParams?: Readonly<Record<string, string>>;
}): URL => {
  const url = input.url instanceof URL ? new URL(input.url.toString()) : new URL(input.url);

  for (const [key, value] of Object.entries(input.queryParams ?? {})) {
    url.searchParams.set(key, value);
  }

  return url;
};

export const applyCookiePlacementsToHeaders = (input: {
  headers: Readonly<Record<string, string>>;
  cookies?: Readonly<Record<string, string>>;
}): Record<string, string> => {
  const cookies = input.cookies ?? {};
  if (Object.keys(cookies).length === 0) {
    return { ...input.headers };
  }

  const cookieHeaderKey = findHeaderKey(input.headers, "cookie");
  const cookieHeaderValue = cookieHeaderKey ? input.headers[cookieHeaderKey] : null;
  const mergedCookies = {
    ...(cookieHeaderValue ? parseCookieHeader(cookieHeaderValue) : {}),
    ...cookies,
  };
  const headers = { ...input.headers };

  headers[cookieHeaderKey ?? "cookie"] = Object.entries(mergedCookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

  return headers;
};

export const applyJsonBodyPlacements = (input: {
  body: unknown;
  bodyValues?: Readonly<Record<string, string>>;
  label?: string;
}): unknown => {
  const bodyValues = input.bodyValues ?? {};
  if (Object.keys(bodyValues).length === 0) {
    return input.body;
  }

  const root =
    input.body == null
      ? {}
      : isRecord(input.body)
        ? structuredClone(input.body)
        : null;

  if (root === null) {
    throw new Error(
      `${input.label ?? "HTTP request"} auth body placements require an object JSON body`,
    );
  }

  for (const [rawPath, value] of Object.entries(bodyValues)) {
    const path = pathSegmentsFromPlacementPath(rawPath);
    if (path.length === 0) {
      throw new Error(
        `${input.label ?? "HTTP request"} auth body placement path cannot be empty`,
      );
    }
    setNestedRecordValue(root, path, value);
  }

  return root;
};
