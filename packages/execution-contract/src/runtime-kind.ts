/**
 * Supported sandbox runtime implementations.
 */
export type RuntimeKind =
  | "quickjs"
  | "ses"
  | "deno-subprocess"
  | "cloudflare-dynamic-worker"
