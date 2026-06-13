import { describe, expect, it } from "@effect/vitest";

import type { CloudflareConfig } from "../config";
import { principalFromAccessClaims } from "./cloudflare-access";

const config: CloudflareConfig = {
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "aud-tag",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: ["admin@example.com"],
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  webBaseUrl: "https://localhost",
  enableDevAuth: false,
};

describe("principalFromAccessClaims", () => {
  it("maps a human identity (email + sub + groups)", () => {
    const p = principalFromAccessClaims(
      { sub: "user-123", email: "person@example.com", name: "Person", groups: ["eng"] },
      config,
    );
    expect(p.accountId).toBe("user-123");
    expect(p.email).toBe("person@example.com");
    expect(p.name).toBe("Person");
    expect(p.roles).toEqual(["eng"]);
    expect(p.organizationId).toBe("default");
  });

  it("grants admin when the email is in the allowlist", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "ADMIN@example.com" }, config);
    expect(p.roles).toContain("admin");
  });

  it("gives a SERVICE TOKEN (common_name, no email/sub) a stable identity", () => {
    // Cloudflare Access service-token JWT: common_name set, email/sub absent.
    const p = principalFromAccessClaims({ common_name: "df8a20db.access", type: "app" }, config);
    expect(p.accountId).toBe("df8a20db.access"); // not empty — stable per token
    expect(p.name).toBe("df8a20db.access");
    expect(p.email).toBe("df8a20db.access@service-token.internal"); // synthetic, non-routable
    expect(p.roles).toEqual(["member"]); // a token is a member, not an admin
    expect(p.organizationId).toBe("default");
  });

  it("aliases a SERVICE TOKEN to its mapped human subject, as admin", () => {
    // When the verifier resolves an alias (common_name → subject), the token
    // ACTS AS that human: same subject partition, admin role, synthetic email.
    const p = principalFromAccessClaims(
      { common_name: "df8a20db.access", type: "app" },
      config,
      "527888ce-human-sub",
    );
    expect(p.accountId).toBe("527888ce-human-sub");
    expect(p.roles).toContain("admin");
    expect(p.email).toBe("df8a20db.access@service-token.internal"); // synthetic, non-routable
    expect(p.name).toBe("df8a20db.access");
  });

  it("ignores an aliasedSubject for a human (sub present) — no token hijack", () => {
    const p = principalFromAccessClaims(
      { sub: "real-human", email: "person@example.com" },
      config,
      "someone-else",
    );
    expect(p.accountId).toBe("real-human");
  });

  it("defaults to member when there are no groups and no admin match", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "nobody@other.com" }, config);
    expect(p.roles).toEqual(["member"]);
  });
});
