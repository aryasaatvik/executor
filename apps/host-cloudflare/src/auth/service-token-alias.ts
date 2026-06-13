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
// `data` is `{ subject: string }`.
// ---------------------------------------------------------------------------

const ALIAS_PLUGIN_ID = "service-tokens";
const ALIAS_COLLECTION = "aliases";

/** Resolve a service token's `common_name` to the subject it should act as, or
 *  null when it is unmapped. Never fails — a DB error resolves to null. */
export type ServiceTokenAliasLookup = (commonName: string) => Effect.Effect<string | null>;

export const makeServiceTokenAliasLookup =
  (handle: ExecutorDbHandle, tenant: string): ServiceTokenAliasLookup =>
  (commonName) =>
    readOrgPluginStorageData(handle.db, {
      tenant,
      pluginId: ALIAS_PLUGIN_ID,
      collection: ALIAS_COLLECTION,
      key: commonName,
    }).pipe(
      Effect.map(subjectFromData),
      // A read failure must never break the auth path — fail OPEN to "no alias"
      // (the token keeps its own partition) rather than 500 the request.
      Effect.orElseSucceed(() => null),
    );

const subjectFromData = (data: unknown): string | null => {
  const value =
    data != null && typeof data === "object" && "subject" in data
      ? (data as { readonly subject: unknown }).subject
      : null;
  return typeof value === "string" && value.length > 0 ? value : null;
};
