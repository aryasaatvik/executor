// Stub prettier formatter — control-plane does not depend on prettier.
// Returns code as-is. The engine's version uses prettier/standalone for
// formatted type previews; this is a best-effort fallback.

export type PrettierParser = "json" | "typescript" | "typescript-module";

export async function formatWithPrettier(
  code: string,
  _parser: PrettierParser,
): Promise<string> {
  return code.trimEnd();
}
