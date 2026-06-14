import { createRemoteJWKSet, jwtVerify } from "jose";
import { Effect, Layer, Option, Schema } from "effect";

import { IdentityProvider, Unauthorized, type Principal } from "@executor-js/api/server";
import type { ExecutionActor } from "@executor-js/sdk/core";

import type { CloudflareConfig } from "../config";
import type { ResolvedServiceTokenAlias, ServiceTokenAliasLookup } from "./service-token-alias";

// ---------------------------------------------------------------------------
// Access claim parsing
//
// The three identity claims are decoded with a lenient Schema (→ Option) so a
// malformed payload normalizes to all-absent rather than throwing in the auth
// path. A human carries `sub` (usually with `email`); a service token carries
// only `common_name`. The display-name and groups claims use operator-
// configurable keys, so they are read off the raw payload separately.
// ---------------------------------------------------------------------------

const AccessClaims = Schema.Struct({
  sub: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  common_name: Schema.optional(Schema.String),
});

interface AccessIdentity {
  readonly sub: string;
  readonly email: string;
  readonly commonName: string;
}

const decodeAccessClaims = Schema.decodeUnknownOption(AccessClaims);

const accessIdentity = (claims: Record<string, unknown>): AccessIdentity =>
  Option.match(decodeAccessClaims(claims), {
    onNone: () => ({ sub: "", email: "", commonName: "" }),
    onSome: (c) => ({ sub: c.sub ?? "", email: c.email ?? "", commonName: c.common_name ?? "" }),
  });

/** A service token presents `common_name` and no `sub`. */
const isServiceToken = (id: AccessIdentity): boolean => id.sub === "" && id.commonName !== "";

/** A service token has no mailbox; synthesize a stable, clearly-non-routable
 *  address from its common_name. `.internal` is the ICANN-reserved private-use
 *  TLD (2024) — it never resolves publicly and reads as an internal machine
 *  credential, not an invalid one. */
const serviceTokenEmail = (commonName: string): string => `${commonName}@service-token.internal`;

// ---------------------------------------------------------------------------
// Cloudflare Access IdentityProvider — the CF-native swap for self-host's
// Better Auth. Cloudflare Access (Zero Trust) sits IN FRONT of the Worker and
// authenticates the human; it forwards a signed `Cf-Access-Jwt-Assertion` JWT.
// This provider verifies that JWT against the team's public JWKS and maps its
// claims onto the neutral `Principal`. There is no app-level login, no session
// store, no password — the IdP is the gate.
//
// Single-tenant: every verified principal belongs to the one configured org.
// Roles come from the admin allowlist + the Access groups claim.
// ---------------------------------------------------------------------------

/**
 * Map verified Access JWT claims onto the neutral `Principal`. Pure (no JWT
 * verification) so it is unit-testable. Handles both human identities (email +
 * sub, optional groups) and SERVICE TOKENS — machine/API-key auth via the
 * `CF-Access-Client-Id`/`-Secret` headers — which carry `common_name` (the
 * token's client id) instead of email/sub. Single-tenant: every principal
 * belongs to the one configured org; admin comes from the email allowlist.
 *
 * A service token can be ALIASED to a human subject: pass the resolved `alias`
 * (from the service-tokens plugin's table). When present for a service token, the
 * token acts as that identity — same subject → same Personal connection
 * partition (zero migration) — and is treated as an admin: the deliberate
 * static-credential equivalent of that user's browser/OAuth session, with the
 * human's stored email/name surfaced so "Acts as" reads as a person.
 *
 * EVERY service token (aliased or not) also carries an `actor` keyed by its
 * client id, so runs attribute to the TOKEN (distinct from the human subject it
 * may share a partition with) — labelled by the friendly machine name when
 * aliased. The lookup is async I/O, so it stays in the verifier; this mapper is
 * kept pure (alias passed in) and unit-testable.
 */
export const principalFromAccessClaims = (
  claims: Record<string, unknown>,
  config: CloudflareConfig,
  alias?: ResolvedServiceTokenAlias | null,
): Principal => {
  const id = accessIdentity(claims);
  const nameClaim = claims[config.accessNameClaim];
  const groupsClaim = claims[config.accessGroupsClaim];
  const groups = Array.isArray(groupsClaim) ? groupsClaim.map(String) : [];
  // Admin is keyed off the REAL email claim — a synthetic service-token address
  // can never match the allowlist.
  const isAdmin = id.email.length > 0 && config.adminEmails.includes(id.email.toLowerCase());

  if (isServiceToken(id)) {
    // The token attributes runs to ITSELF (its client id), labelled by the
    // friendly machine name when aliased, else the raw client id.
    const actor: ExecutionActor = {
      kind: "service-token",
      id: id.commonName,
      label: alias?.machineName ?? id.commonName,
    };
    if (alias) {
      // Aliased → act as the mapped human subject, as an admin. Surface the
      // human's stored email/name (so "Acts as" shows a person), falling back to
      // the synthetic machine address when the alias predates capture.
      return {
        accountId: alias.subject,
        organizationId: config.organizationId,
        organizationName: config.organizationName,
        organizationSlug: config.organizationSlug,
        email: alias.email ?? serviceTokenEmail(id.commonName),
        name: alias.name ?? id.commonName,
        avatarUrl: null,
        roles: ["admin", ...groups],
        actor,
      };
    }
    // Unaliased service token → its own subject partition.
    return {
      accountId: id.commonName,
      organizationId: config.organizationId,
      organizationName: config.organizationName,
      organizationSlug: config.organizationSlug,
      email: serviceTokenEmail(id.commonName),
      name: id.commonName,
      avatarUrl: null,
      roles: groups.length > 0 ? groups : ["member"],
      actor,
    };
  }

  return {
    accountId: id.sub || id.email || id.commonName,
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email: id.email,
    name: typeof nameClaim === "string" ? nameClaim : id.commonName || null,
    avatarUrl: null,
    roles: isAdmin ? ["admin", ...groups] : groups.length > 0 ? groups : ["member"],
  };
};

/**
 * Resolve a request to its verified `Principal`, or `null` when the Access
 * assertion is missing/invalid. The single source of truth for "who is this
 * request", shared by the `IdentityProvider` (the API gate) and the MCP auth
 * provider (the `/mcp` gate) so both enforce Access identically.
 *
 * `jose` caches + rotates the team JWKS, so build the verifier once per config.
 */
export const makeAccessVerifier = (
  config: CloudflareConfig,
  aliasLookup?: ServiceTokenAliasLookup,
) => {
  const issuer = `https://${config.accessTeamDomain}`;
  // Cached, lazily-fetched team signing keys; jose handles rotation + caching.
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  // Dev/single-user escape hatch: bypass Access entirely, every request is a
  // fixed admin. Only when explicitly enabled (and the instance is otherwise
  // unprotected). Mirrors the local app's single-user model.
  const devPrincipal: Principal = {
    accountId: "dev",
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email: config.adminEmails[0] ?? "dev@local",
    name: "Dev",
    avatarUrl: null,
    roles: ["admin"],
  };

  const verify = (request: Request): Effect.Effect<Principal | null> =>
    Effect.gen(function* () {
      if (config.enableDevAuth) return devPrincipal;
      const token = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!token) return null;

      const verified = yield* Effect.tryPromise({
        try: () => jwtVerify(token, jwks, { issuer, audience: config.accessAud }),
        catch: () => "invalid access assertion",
      }).pipe(Effect.orElseSucceed(() => null));
      if (!verified) return null;

      const claims = verified.payload as Record<string, unknown>;
      // A service token (common_name, no sub) may be aliased to a human subject.
      // Resolve it before building the principal so the token acts as that user.
      const id = accessIdentity(claims);
      const alias =
        isServiceToken(id) && aliasLookup ? yield* aliasLookup(id.commonName) : null;

      return principalFromAccessClaims(claims, config, alias);
    });

  return { verify };
};

export const cloudflareAccessIdentityLayer = (
  config: CloudflareConfig,
  aliasLookup?: ServiceTokenAliasLookup,
): Layer.Layer<IdentityProvider> => {
  const { verify } = makeAccessVerifier(config, aliasLookup);
  return Layer.succeed(IdentityProvider)(
    IdentityProvider.of({
      authenticate: (request) =>
        verify(request).pipe(
          Effect.flatMap((principal) =>
            principal ? Effect.succeed(principal) : Effect.fail(new Unauthorized()),
          ),
        ),
    }),
  );
};
