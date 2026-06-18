const normalizeForCacheKey = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeForCacheKey);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = normalizeForCacheKey((value as Record<string, unknown>)[key]);
  }
  return out;
};

export const cacheKeyPayload = (value: unknown): string =>
  JSON.stringify(normalizeForCacheKey(value));
