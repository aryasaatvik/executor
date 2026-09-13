import { describe, expect, it } from "@effect/vitest";
import type { IntegrationPlugin } from "@executor-js/sdk/client";

import {
  availableCatalogKinds,
  catalogIntegrationIdentity,
  filterCatalogEntries,
  parseCatalogSearch,
  pickConnectTarget,
  presetDomains,
} from "./integrations-sh-catalog";

const plugin = (key: string, presets: IntegrationPlugin["presets"]): IntegrationPlugin => ({
  key,
  label: key,
  add: () => null,
  presets,
});

describe("parseCatalogSearch", () => {
  it("keeps connectable kinds and drops CLI-only entries", () => {
    const entries = parseCatalogSearch({
      results: [
        { domain: "linear.app", description: "Issues", kinds: ["mcp", "cli"] },
        { domain: "cli-only.dev", description: "A CLI", kinds: ["cli"] },
      ],
    });
    expect(entries).toEqual([{ domain: "linear.app", description: "Issues", kinds: ["mcp"] }]);
  });

  it("returns nothing for a malformed payload", () => {
    expect(parseCatalogSearch({ nope: true })).toEqual([]);
    expect(parseCatalogSearch(undefined)).toEqual([]);
  });
});

describe("catalogIntegrationIdentity", () => {
  it("keeps an upstream collision suffix out of Executor's namespace", () => {
    expect(
      catalogIntegrationIdentity({
        title: "Samva REST API",
        sourceSlug: "samva-rest-api-2-2-2-2",
      }),
    ).toEqual({
      namespace: "samva_rest_api",
      sourceSlug: "samva-rest-api-2-2-2-2",
    });
  });

  it("is stable across repeated discovery of the same product", () => {
    const first = catalogIntegrationIdentity({
      title: "Samva REST API",
      sourceSlug: "samva-rest-api-2-2-2-2",
    });
    const refreshed = catalogIntegrationIdentity({
      title: "Samva REST API",
      sourceSlug: "samva-rest-api",
    });

    expect(first.namespace).toBe("samva_rest_api");
    expect(refreshed.namespace).toBe(first.namespace);
  });

  it("leaves a real local title collision for the add flow to reject", () => {
    const first = catalogIntegrationIdentity({ title: "Acme API", sourceSlug: "acme-public" });
    const second = catalogIntegrationIdentity({ title: "Acme API", sourceSlug: "acme-private" });

    expect(first.namespace).toBe("acme_api");
    expect(second.namespace).toBe(first.namespace);
    expect(second.sourceSlug).not.toBe(first.sourceSlug);
  });
});

describe("pickConnectTarget", () => {
  const payload = {
    surfaces: [
      { type: "graphql", url: "https://api.linear.app/graphql", slug: "linear-graphql-api" },
      { type: "mcp", url: "https://mcp.linear.app/mcp", slug: "linear" },
      { type: "http", spec: "https://example.com/openapi.json", slug: "example-rest" },
      { type: "cli", slug: "linear-cli" },
    ],
  };

  it("resolves the MCP endpoint for the mcp kind", () => {
    expect(pickConnectTarget(payload, "mcp")).toEqual({
      kind: "mcp",
      url: "https://mcp.linear.app/mcp",
      slug: "linear",
    });
  });

  it("resolves the spec URL (not the base URL) for the openapi kind", () => {
    expect(pickConnectTarget(payload, "openapi")).toEqual({
      kind: "openapi",
      url: "https://example.com/openapi.json",
      slug: "example-rest",
    });
  });

  it("resolves the GraphQL endpoint for the graphql kind", () => {
    expect(pickConnectTarget(payload, "graphql")).toEqual({
      kind: "graphql",
      url: "https://api.linear.app/graphql",
      slug: "linear-graphql-api",
    });
  });

  it("skips specless http surfaces for the openapi kind", () => {
    const specless = { surfaces: [{ type: "http", url: "https://api.example.com" }] };
    expect(pickConnectTarget(specless, "openapi")).toBeUndefined();
  });

  it("returns undefined for a malformed document", () => {
    expect(pickConnectTarget({ surfaces: "nope" }, "mcp")).toBeUndefined();
  });
});

describe("preset filtering", () => {
  const plugins: IntegrationPlugin[] = [
    plugin("mcp", [
      {
        id: "linear",
        name: "Linear",
        summary: "Issues",
        icon: "https://integrations.sh/logo/linear.app",
      },
    ]),
    plugin("openapi", [
      {
        id: "stripe",
        name: "Stripe",
        summary: "Payments",
        url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
        icon: "https://integrations.sh/logo/stripe.com",
      },
    ]),
  ];

  it("derives preset domains from logo-proxy icons and preset URLs", () => {
    const domains = presetDomains(plugins);
    expect(domains.has("linear.app")).toBe(true);
    expect(domains.has("stripe.com")).toBe(true);
  });

  it("lists only kinds a loaded plugin can add", () => {
    expect(availableCatalogKinds(plugins)).toEqual(["mcp", "openapi"]);
  });

  it("hides preset-covered domains and unaddable kinds", () => {
    const entries = filterCatalogEntries(
      [
        { domain: "linear.app", description: "Issues", kinds: ["mcp"] },
        { domain: "shopify.dev", description: "Commerce", kinds: ["graphql"] },
        { domain: "notion.com", description: "Notes", kinds: ["mcp", "graphql"] },
      ],
      { excludeDomains: presetDomains(plugins), availableKinds: availableCatalogKinds(plugins) },
    );
    expect(entries).toEqual([{ domain: "notion.com", description: "Notes", kinds: ["mcp"] }]);
  });
});
