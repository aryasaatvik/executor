import { Effect } from "effect";

import { readOrgPluginStorageData, type ExecutorDbHandle } from "@executor-js/api/server";

// ---------------------------------------------------------------------------
// Service-token alias resolver — the host half of the service-tokens plugin.
//
// A Cloudflare Access service token carries only `common_name` (no sub/email),
// so by default it lands in its own subject partition and can't see a human's
// Personal connections. The `@executor-js/plugin-service-tokens` plugin lets a
// user map a token's `common_name` to their own Access `sub`; this resolves that
// mapping at JWT-verify time so the token ACTS AS that human.
//
// Contract with the plugin: it persists aliases in the shared `plugin_storage`
// table under this exact (plugin_id, collection) pair, `owner: "org"` (so they
// are tenant-shared and resolvable here with only the tenant id). The stored
// `data` is `{ subject, machineName, email, name }` — subject is the human the
// token acts as; the rest are display fields captured at alias time.
// ---------------------------------------------------------------------------

const ALIAS_PLUGIN_ID = "service-tokens";
const ALIAS_COLLECTION = "aliases";

/** A resolved service-token alias: the human `subject` the token acts as, plus
 *  the display fields captured at alias time (the token's friendly machine name
 *  and the aliasing user's email/name). */
export interface ResolvedServiceTokenAlias {
  readonly subject: string;
  readonly machineName: string | null;
  readonly email: string | null;
  readonly name: string | null;
}

/** Resolve a service token's `common_name` to its alias, or null when it is
 *  unmapped. Never fails — a DB error resolves to null. */
export type ServiceTokenAliasLookup = (
  commonName: string,
) => Effect.Effect<ResolvedServiceTokenAlias | null>;

export const makeServiceTokenAliasLookup =
  (handle: ExecutorDbHandle, tenant: string): ServiceTokenAliasLookup =>
  (commonName) =>
    readOrgPluginStorageData(handle.db, {
      tenant,
      pluginId: ALIAS_PLUGIN_ID,
      collection: ALIAS_COLLECTION,
      key: commonName,
    }).pipe(
      Effect.map(aliasFromData),
      // A read failure must never break the auth path — fail OPEN to "no alias"
      // (the token keeps its own partition) rather than 500 the request.
      Effect.orElseSucceed(() => null),
    );

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const aliasFromData = (data: unknown): ResolvedServiceTokenAlias | null => {
  if (data == null || typeof data !== "object" || !("subject" in data)) return null;
  const record = data as {
    readonly subject: unknown;
    readonly machineName?: unknown;
    readonly email?: unknown;
    readonly name?: unknown;
  };
  const subject = nonEmptyString(record.subject);
  if (subject === null) return null;
  return {
    subject,
    machineName: nonEmptyString(record.machineName),
    email: nonEmptyString(record.email),
    name: nonEmptyString(record.name),
  };
};
