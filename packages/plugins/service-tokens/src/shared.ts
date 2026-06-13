// ---------------------------------------------------------------------------
// @executor-js/plugin-service-tokens/shared
//
// Schemas + the HttpApiGroup shared between the server handlers and the client
// page, so both see the exact same alias contracts with no codegen.
//
// A "service-token alias" maps a Cloudflare Access service token's
// `common_name` (its Client ID — the only identity a machine token carries) to
// the human Access `sub` it should act as. The host's auth seam reads these at
// JWT-verify time so an MCP client using `Cf-Access-Client-Id`/`-Secret` headers
// resolves that user's Personal connections instead of its own empty partition.
//
// No React or Node imports here — server and client both import this.
// ---------------------------------------------------------------------------

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { InternalError } from "@executor-js/sdk/shared";

export const ServiceTokenAlias = Schema.Struct({
  /** The Cloudflare Access service-token `common_name` (its Client ID). */
  commonName: Schema.String,
  /** The human Access `sub` this token acts as. */
  subject: Schema.String,
});
export type ServiceTokenAlias = typeof ServiceTokenAlias.Type;

// `InternalError` is the shared opaque 500 schema; the handlers downgrade the
// storage layer's `StorageFailure` to it at the HTTP edge via `capture`.
export const ServiceTokensApi = HttpApiGroup.make("serviceTokens")
  .add(
    HttpApiEndpoint.get("list", "/aliases", {
      success: Schema.Array(ServiceTokenAlias),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("alias", "/aliases", {
      // The subject is NOT in the payload: the alias always targets the calling
      // user's own subject (server reads it from the request principal), so a
      // user can only ever alias a token to themselves.
      payload: Schema.Struct({ commonName: Schema.String }),
      success: ServiceTokenAlias,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("unalias", "/aliases/remove", {
      payload: Schema.Struct({ commonName: Schema.String }),
      success: Schema.Struct({ ok: Schema.Boolean }),
      error: InternalError,
    }),
  );
