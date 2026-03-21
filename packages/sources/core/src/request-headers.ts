export const hasAuthorizationHeader = (
  headers: Readonly<Record<string, string>> | null | undefined,
): boolean =>
  headers !== null
  && headers !== undefined
  && Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
