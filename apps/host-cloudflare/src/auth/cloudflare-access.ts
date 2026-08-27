import { createRemoteJWKSet, jwtVerify } from "jose";
import { Effect, Layer, Option, Schema } from "effect";

import { IdentityProvider, Unauthorized, type Principal } from "@executor-js/api/server";
import type { ExecutionActor } from "@executor-js/sdk/core";

import type { CloudflareConfig } from "../config";
import type { ResolvedServiceTokenAlias, ServiceTokenAliasLookup } from "./service-token-alias";

const AccessClaims = Schema.Struct({
  sub: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  common_name: Schema.optional(Schema.String),
});
type AccessIdentity = { readonly sub: string; readonly email: string; readonly commonName: string };
const decodeAccessClaims = Schema.decodeUnknownOption(AccessClaims);
const accessIdentity = (claims: Record<string, unknown>): AccessIdentity =>
  Option.match(decodeAccessClaims(claims), {
    onNone: () => ({ sub: "", email: "", commonName: "" }),
    onSome: (value) => ({
      sub: value.sub ?? "",
      email: value.email ?? "",
      commonName: value.common_name ?? "",
    }),
  });
const isServiceToken = (identity: AccessIdentity): boolean =>
  identity.sub === "" && identity.commonName !== "";
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
 */
export const principalFromAccessClaims = (
  claims: Record<string, unknown>,
  config: CloudflareConfig,
  alias?: ResolvedServiceTokenAlias | null,
): Principal => {
  const identity = accessIdentity(claims);
  const nameClaim = claims[config.accessNameClaim];
  const groupsClaim = claims[config.accessGroupsClaim];
  const groups = Array.isArray(groupsClaim) ? groupsClaim.map(String) : [];
  const isAdmin =
    identity.email.length > 0 && config.adminEmails.includes(identity.email.toLowerCase());

  if (isServiceToken(identity)) {
    const actor: ExecutionActor = {
      kind: "service-token",
      id: identity.commonName,
      label: alias?.machineName ?? identity.commonName,
    };
    if (alias) {
      return {
        kind: "member",
        accountId: alias.subject,
        organizationId: config.organizationId,
        organizationName: config.organizationName,
        organizationSlug: config.organizationSlug,
        email: alias.email ?? serviceTokenEmail(identity.commonName),
        name: alias.name ?? identity.commonName,
        avatarUrl: null,
        roles: ["admin", ...groups],
        orgRoleModel: "organization",
        orgRole: "admin",
        actor,
      };
    }
    return {
      kind: "member",
      accountId: identity.commonName,
      organizationId: config.organizationId,
      organizationName: config.organizationName,
      organizationSlug: config.organizationSlug,
      email: serviceTokenEmail(identity.commonName),
      name: identity.commonName,
      avatarUrl: null,
      roles: groups.length > 0 ? groups : ["member"],
      orgRoleModel: "organization",
      orgRole: "member",
      actor,
    };
  }

  return {
    kind: "member",
    accountId: identity.sub || identity.email || identity.commonName,
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email: identity.email,
    name: typeof nameClaim === "string" ? nameClaim : identity.commonName || null,
    avatarUrl: null,
    roles: isAdmin ? ["admin", ...groups] : groups.length > 0 ? groups : ["member"],
    orgRoleModel: "organization",
    orgRole: isAdmin ? "admin" : "member",
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
  const jwks = config.enableDevAuth
    ? null
    : createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  // Dev/single-user escape hatch: bypass Access entirely, every request is a
  // fixed admin. Only when explicitly enabled (and the instance is otherwise
  // unprotected). Mirrors the local app's single-user model.
  const devPrincipal: Principal = {
    kind: "member",
    accountId: "dev",
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email: config.adminEmails[0] ?? "dev@local",
    name: "Dev",
    avatarUrl: null,
    roles: ["admin"],
    orgRoleModel: "organization",
    orgRole: "admin",
  };

  const verify = (request: Request): Effect.Effect<Principal | null> =>
    Effect.gen(function* () {
      if (config.enableDevAuth) return devPrincipal;
      if (!jwks) return null;
      const token = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!token) return null;

      const verified = yield* Effect.tryPromise({
        try: () => jwtVerify(token, jwks, { issuer, audience: config.accessAud }),
        catch: () => "invalid access assertion",
      }).pipe(Effect.orElseSucceed(() => null));
      if (!verified) return null;

      const claims = verified.payload as Record<string, unknown>;
      const identity = accessIdentity(claims);
      const alias =
        isServiceToken(identity) && aliasLookup ? yield* aliasLookup(identity.commonName) : null;
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
