import { randomUUID } from "node:crypto";
import { assert, expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
const spec = (count: number) =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Large catalog", version: "1" },
    paths: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `/items/${i}`,
        {
          get: {
            operationId: `item${i}`,
            responses: {
              "200": {
                description: "Item details",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
              },
            },
          },
        },
      ]),
    ),
    components: {
      schemas: {
        Item: {
          type: "object",
          properties: {
            id: { type: "string" },
            description: { type: "string", description: "Item description. ".repeat(2000) },
          },
        },
      },
    },
  });

scenario(
  "OpenAPI · large imports report complete counts and preserve unrelated catalogs",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const http = yield* client(api, identity);
    const slug = IntegrationSlug.make(`large-${randomUUID()}`);
    const neighbor = IntegrationSlug.make(`neighbor-${randomUUID()}`);
    yield* Effect.gen(function* () {
      const add = (integration: string, count: number) =>
        http.openapi.addSpec({
          payload: {
            slug: integration,
            spec: { kind: "blob", value: spec(count) },
            baseUrl: "https://example.invalid",
            authenticationTemplate: [],
          },
        });
      expect((yield* add(neighbor, 1001)).toolCount).toBe(1001);
      expect((yield* add(slug, 1201)).toolCount).toBe(1201);
      yield* http.connections.create({
        payload: {
          owner: "org",
          integration: slug,
          name: ConnectionName.make("main"),
          template: AuthTemplateSlug.make("none"),
          value: "catalog-fixture",
        },
      });
      expect(yield* http.tools.list({ query: { integration: slug } })).toHaveLength(1201);
      const updated = yield* http.openapi.updateSpec({
        params: { slug },
        payload: {
          spec: { kind: "blob", value: spec(1002) },
        },
      });
      expect(updated.toolCount).toBe(1002);
      expect(updated.removedTools).toHaveLength(199);
      expect(updated.addedTools).toEqual([]);
      const failed = yield* http.openapi
        .updateSpec({
          params: { slug },
          payload: {
            spec: { kind: "blob", value: "invalid" },
          },
        })
        .pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      const intact = yield* http.openapi.updateSpec({
        params: { slug: neighbor },
        payload: {
          spec: { kind: "blob", value: spec(1001) },
        },
      });
      expect(intact.toolCount).toBe(1001);
      expect(intact.removedTools).toEqual([]);
      const retry = yield* http.openapi.updateSpec({
        params: { slug },
        payload: {
          spec: { kind: "blob", value: spec(1002) },
        },
      });
      expect(retry.toolCount).toBe(1002);
      expect(retry.addedTools).toEqual([]);
      expect(retry.removedTools).toEqual([]);
      const catalog = yield* http.tools.list({ query: { integration: slug } });
      expect(catalog).toHaveLength(1002);
      const first = catalog[0];
      assert(first);
      const schema = yield* http.tools.schema({
        query: { address: first.address },
      });
      expect(JSON.stringify(schema)).toContain("description");
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the imported catalog after refresh", async () => {
          await visit(page, `/integrations/${slug}?tab=tools`);
          await page.getByPlaceholder("Filter 1002 tools…").waitFor();
        });
      });
    }).pipe(
      Effect.ensuring(
        Effect.forEach(
          [slug, neighbor],
          (slug) => http.openapi.removeSpec({ params: { slug } }).pipe(Effect.orDie),
          {
            discard: true,
          },
        ),
      ),
    );
  }),
);
