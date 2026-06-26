import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Predicate, Result } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";

import { ToolNotFoundError } from "./errors";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { IntegrationDetectionResult } from "./types";
import { makeTestExecutor } from "./testing";
import { serveOAuthTestServer } from "./testing/oauth-test-server";
import { toolSchemaViewManifestCacheKey } from "./tool-schema-view-cache";
import { toolTypeScriptPreviewCacheKey } from "./tool-typescript-preview-cache";

// removed: v1 secret browser-handoff, source.configure, case-insensitive tool-id
// resolution, secrets/sources/scope-stack. The integration coverage below is
// ported to the v2 surface (integrations/connections/OAuth/resolveTools/execute/
// tools.schema).

class TestPluginError extends Data.TaggedError("TestPluginError")<{
  readonly message: string;
}> {}

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const INTEG = IntegrationSlug.make("demo");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONN = ConnectionName.make("main");

const addr = (tool: string): ToolAddress => ToolAddress.make(`tools.${INTEG}.org.${CONN}.${tool}`);

const demoDefinitions = {
  Pet: { anyOf: [{ $ref: "#/$defs/Dog" }, { $ref: "#/$defs/Cat" }] },
  Dog: {
    type: "object",
    properties: { collar: { $ref: "#/$defs/Collar" } },
  },
  Cat: { type: "object", properties: { lives: { type: "number" } } },
  Collar: { type: "object", properties: { id: { type: "string" } } },
  Owner: { type: "object", properties: { pet: { $ref: "#/$defs/Pet" } } },
  // Regression fixture: unused provider definitions can be malformed.
  // Tool previews must compile only the definitions reachable from the
  // requested tool's schema roots.
  Unused: { type: "object", properties: { broken: { $ref: "#/$defs/Missing" } } },
};

// ---------------------------------------------------------------------------
// A plugin that registers an integration, produces per-connection tools via
// resolveTools (with shared $defs), and supports ctx.transaction rollback.
// ---------------------------------------------------------------------------

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  credentialProviders: [memoryProvider()],
  storage: ({ pluginStorage }) => ({
    put: (owner: "org" | "user", key: string, value: string) =>
      pluginStorage.put({ collection: "item", key, owner, data: { value } }).pipe(Effect.asVoid),
    list: () =>
      pluginStorage
        .list<{ readonly value: string }>({ collection: "item" })
        .pipe(Effect.map((rows) => rows.map((row) => ({ id: row.key, value: row.data.value })))),
  }),
  resolveTools: () =>
    Effect.succeed({
      tools: [
        {
          name: ToolName.make("inspect"),
          description: "inspect",
          inputSchema: {
            type: "object",
            properties: { pet: { $ref: "#/$defs/Pet" } },
            required: ["pet"],
          },
          outputSchema: { $ref: "#/$defs/Owner" },
        },
        { name: ToolName.make("run"), description: "run" },
      ],
      definitions: demoDefinitions,
    }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Demo",
        config: {},
      }),
    storagePut: (owner: "org" | "user", key: string, value: string) =>
      ctx.storage.put(owner, key, value),
    storageList: () => ctx.storage.list(),
    failAfterPluginAndCoreWrites: () =>
      ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.storage.put("org", "tx-row", "created-before-failure");
          yield* ctx.core.integrations.register({
            slug: IntegrationSlug.make("tx-integration"),
            description: "Tx",
            config: {},
          });
          return yield* new TestPluginError({ message: "rollback" });
        }),
      ),
  }),
}))();

const detector = (id: string, confidence: IntegrationDetectionResult["confidence"]) =>
  definePlugin(() => ({
    id,
    storage: () => ({}),
    detect: () =>
      Effect.succeed(
        IntegrationDetectionResult.make({
          kind: id,
          confidence,
          endpoint: `https://example.com/${id}`,
          name: id,
          slug: id,
        }),
      ),
  }))();

describe("createExecutor", () => {
  it.effect("rolls back plugin and core writes from ctx.transaction failures", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      const result = yield* Effect.result(executor.demo.failAfterPluginAndCoreWrites());
      expect(Result.isFailure(result)).toBe(true);

      // Neither the plugin row nor the core integration row should survive.
      const rows = yield* executor.demo.storageList();
      expect(rows).toEqual([]);
      const integrations = yield* executor.integrations.list();
      expect(integrations.map((i) => String(i.slug))).not.toContain("tx-integration");
    }),
  );

  it.effect("runs plugin close hooks", () =>
    Effect.gen(function* () {
      let closed = false;
      const closingPlugin = definePlugin(() => ({
        id: "closing" as const,
        storage: () => ({}),
        close: () => Effect.sync(() => void (closed = true)),
      }))();
      const executor = yield* makeTestExecutor({
        plugins: [closingPlugin] as const,
      });
      yield* executor.close();
      expect(closed).toBe(true);
    }),
  );

  it.effect("projects core tools as the built-in Executor integration", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });
      const integrations = yield* executor.integrations.list();
      const executorIntegration = integrations.find((i) => String(i.slug) === "executor");
      expect(executorIntegration).toMatchObject({
        description: "Executor",
        kind: "built-in",
        canRemove: false,
        canRefresh: false,
      });

      const address = ToolAddress.make("executor.coreTools.integrations.list");
      const tools = yield* executor.tools.list({
        integration: IntegrationSlug.make("executor"),
        includeBlocked: true,
      });
      const listed = tools.find((toolRow) => toolRow.address === address);
      expect(listed).toMatchObject({
        address,
        integration: IntegrationSlug.make("executor"),
        connection: ConnectionName.make("coreTools"),
        name: ToolName.make("coreTools.integrations.list"),
        static: true,
      });

      const schema = yield* executor.tools.schema(address);
      expect(schema).toMatchObject({
        address,
        name: "coreTools.integrations.list",
        outputSchema: {
          type: "object",
          required: ["integrations"],
        },
      });

      const out = yield* executor.execute(address, {});
      expect(out).toMatchObject({
        integrations: [expect.objectContaining({ slug: "executor" })],
      });
    }),
  );

  it.effect("can omit provider tools from the built-in Executor integration", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools: {
          webBaseUrl: "http://localhost:3000",
          includeProviders: false,
        },
      });

      const tools = yield* executor.tools.list({
        integration: IntegrationSlug.make("executor"),
        includeBlocked: true,
      });
      const names = tools.map((toolRow) => String(toolRow.name)).sort();

      expect(names).toContain("coreTools.integrations.list");
      expect(names).not.toContain("coreTools.providers.list");
      expect(names).not.toContain("coreTools.providers.items");
    }),
  );

  it.effect("creates provider-backed connections through the built-in Executor tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });
      yield* executor.demo.seed();

      const created = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.create"),
        {
          owner: "org",
          name: String(CONN),
          integration: String(INTEG),
          template: String(TEMPLATE),
          identityLabel: "Demo",
          from: { provider: "memory", id: "secret-token" },
        },
      );
      expect(created).toMatchObject({
        owner: "org",
        name: String(CONN),
        integration: String(INTEG),
        template: String(TEMPLATE),
        address: "tools.demo.org.main",
        identityLabel: "Demo",
        oauthClient: null,
      });

      const listed = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.list"),
        { integration: String(INTEG), owner: "org" },
      );
      expect(listed).toMatchObject({
        connections: [expect.objectContaining({ address: "tools.demo.org.main" })],
      });

      const out = yield* executor.execute(addr("run"), {});
      expect(out).toEqual({ ran: "run" });
    }),
  );

  it.effect("hands pasted credential entry to the web UI", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });

      const handoff = yield* executor.execute(
        ToolAddress.make("executor.coreTools.connections.createHandoff"),
        {
          integration: String(INTEG),
          owner: "user",
          template: String(TEMPLATE),
          label: "Demo token",
        },
      );

      expect(handoff).toMatchObject({
        instructions: expect.stringContaining("Do not ask them to paste"),
      });
      const handoffOutput = handoff as { readonly url: string };
      const url = new URL(handoffOutput.url);
      expect(url.origin).toBe("http://localhost:3000");
      expect(url.pathname).toBe(`/integrations/${String(INTEG)}`);
      expect(url.searchParams.get("addAccount")).toBe("1");
      expect(url.searchParams.get("owner")).toBe("user");
      expect(url.searchParams.get("template")).toBe(String(TEMPLATE));
      expect(url.searchParams.get("label")).toBe("Demo token");
      expect(url.search).not.toContain("secret");
    }),
  );

  it.effect("starts a client-credentials connection through the oauth.start tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const executor = yield* makeTestExecutor({
          plugins: [demoPlugin] as const,
          coreTools: { webBaseUrl: "http://localhost:3000" },
          redirectUri: null,
        });
        yield* executor.demo.seed();

        const client = OAuthClientSlug.make("demo-machine");
        // A confidential client_credentials app carries a secret, so it is
        // registered through the service layer (the browser-handoff path the web
        // UI uses) rather than the agent-facing `oauth.clients.create` tool,
        // which no longer accepts a client secret. The connection still starts
        // through the `oauth.start` tool below.
        const registered = yield* executor.oauth.createClient({
          owner: "org",
          slug: client,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "client_credentials",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.resourceUrl,
        });
        expect(registered).toEqual(client);

        const started = yield* executor.execute(
          ToolAddress.make("executor.coreTools.oauth.start"),
          {
            client: String(client),
            clientOwner: "org",
            owner: "org",
            name: "oauth",
            integration: String(INTEG),
            template: String(TEMPLATE),
          },
        );
        expect(started).toMatchObject({
          status: "connected",
          connection: {
            owner: "org",
            name: "oauth",
            integration: String(INTEG),
            oauthClient: String(client),
            oauthClientOwner: "org",
          },
        });

        const requests = yield* server.requests;
        const tokenRequest = requests.find(
          (request) =>
            request.path === "/token" && request.body.includes("grant_type=client_credentials"),
        );
        expect(tokenRequest).toBeDefined();
        expect(new URLSearchParams(tokenRequest!.body).get("resource")).toBe(server.resourceUrl);

        const out = yield* executor.execute(ToolAddress.make("tools.demo.org.oauth.run"), {});
        expect(out).toEqual({ ran: "run" });
      }),
    ),
  );

  it.effect("orders integration detection results by confidence", () =>
    Effect.gen(function* () {
      const plugins = [
        detector("low-detector", "low"),
        detector("high-detector", "high"),
        detector("medium-detector", "medium"),
      ] as const;
      const executor = yield* makeTestExecutor({ plugins });
      const results = yield* executor.integrations.detect("https://example.com/thing");
      // Every detector recognizes the URL; the list contains all three.
      expect(results.map((r) => r.kind).sort()).toEqual([
        "high-detector",
        "low-detector",
        "medium-detector",
      ]);
    }),
  );

  it.effect("tools.schema returns roots with shared reachable definitions", () =>
    Effect.gen(function* () {
      const cacheRows = new Map<string, string>();
      const cache = KeyValueStore.makeStringOnly({
        get: (key) => Effect.sync(() => cacheRows.get(key)),
        set: (key, value) =>
          Effect.sync(() => {
            cacheRows.set(key, value);
          }),
        remove: (key) =>
          Effect.sync(() => {
            cacheRows.delete(key);
          }),
        clear: Effect.sync(() => {
          cacheRows.clear();
        }),
        size: Effect.sync(() => cacheRows.size),
      });
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
        cache,
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      const schema = yield* executor.tools.schema(addr("inspect"));
      expect(schema).not.toBeNull();
      const defs = schema?.schemaDefinitions ?? {};
      // Reachable defs from inspect's input/output are attached; Unused is not.
      expect(Object.keys(defs).sort()).toEqual(["Cat", "Collar", "Dog", "Owner", "Pet"]);
      expect(schema?.inputTypeScript).not.toBe("unknown");
      expect(schema?.outputTypeScript).not.toBe("unknown");

      const cacheKey = yield* toolTypeScriptPreviewCacheKey({
        inputSchema: schema?.inputSchema,
        outputSchema: schema?.outputSchema,
        definitions: defs,
      });
      const cached = yield* cache.get(cacheKey);
      expect(cached).toContain("preview");

      const manifest = (yield* executor.tools.manifest({ integration: INTEG })).find(
        (entry) => entry.address === addr("inspect"),
      );
      expect(manifest).toBeDefined();
      if (manifest === undefined) return;
      const schemaViewCacheKey = yield* toolSchemaViewManifestCacheKey({
        address: String(addr("inspect")),
        indexFingerprint: manifest.indexFingerprint,
        fingerprintVersion: manifest.fingerprintVersion,
      });
      const cachedSchemaView = yield* cache.get(schemaViewCacheKey);
      expect(cachedSchemaView).toContain("view");
    }),
  );

  it.effect("tools.manifest returns refresh-written schema fingerprints", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      const manifests = yield* executor.tools.manifest({
        integration: INTEG,
        includeBlocked: true,
      });
      expect(manifests.map((manifest) => manifest.path).sort()).toEqual([
        `${INTEG}.org.${CONN}.inspect`,
        `${INTEG}.org.${CONN}.run`,
      ]);
      const inspect = manifests.find((manifest) => manifest.name === "inspect");
      expect(inspect).toMatchObject({
        address: addr("inspect"),
        integration: String(INTEG),
        connection: String(CONN),
        pluginId: "demo",
        fingerprintVersion: "tool-schema-manifest/v1",
      });
      expect(inspect?.inputSchemaHash).toHaveLength(64);
      expect(inspect?.outputSchemaHash).toHaveLength(64);
      expect(inspect?.definitionSetHash).toHaveLength(64);
      expect(inspect?.indexFingerprint).toHaveLength(64);

      const schema = yield* executor.tools.schema(addr("inspect"));
      expect(schema?.schemaDefinitions).not.toHaveProperty("Unused");
    }),
  );

  it.effect("tools.manifest includes static tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });
      const manifests = yield* executor.tools.manifest({
        integration: IntegrationSlug.make("executor"),
        includeBlocked: true,
      });
      expect(manifests.map((manifest) => manifest.address)).toContain(
        ToolAddress.make("executor.coreTools.integrations.list"),
      );
      const listed = manifests.find(
        (manifest) => manifest.address === ToolAddress.make("executor.coreTools.integrations.list"),
      );
      expect(listed).toMatchObject({
        path: "executor.coreTools.integrations.list",
        integration: "executor",
        connection: "coreTools",
        fingerprintVersion: "tool-schema-manifest/v1",
      });
    }),
  );

  it.effect("connections.refresh replaces stale tool manifest rows", () =>
    Effect.gen(function* () {
      let includeInspect = true;
      const dynamicPlugin = definePlugin(() => ({
        id: "dynamicManifest" as const,
        credentialProviders: [memoryProvider()],
        storage: () => ({}),
        resolveTools: () =>
          Effect.succeed({
            tools: [
              ...(includeInspect
                ? [
                    {
                      name: ToolName.make("inspect"),
                      description: "inspect",
                      inputSchema: { type: "object" },
                    },
                  ]
                : []),
              { name: ToolName.make("run"), description: "run" },
            ],
            definitions: {},
          }),
        invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
        extension: (ctx) => ({
          seed: () =>
            ctx.core.integrations.register({
              slug: INTEG,
              description: "Dynamic",
              config: {},
            }),
        }),
      }))();

      const executor = yield* makeTestExecutor({
        plugins: [dynamicPlugin] as const,
      });
      yield* executor.dynamicManifest.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      expect((yield* executor.tools.manifest({ integration: INTEG })).map((m) => m.name)).toEqual([
        "inspect",
        "run",
      ]);

      includeInspect = false;
      yield* executor.connections.refresh({
        owner: "org",
        integration: INTEG,
        name: CONN,
      });

      expect((yield* executor.tools.manifest({ integration: INTEG })).map((m) => m.name)).toEqual([
        "run",
      ]);
    }),
  );

  it.effect("tools.manifest syncs stale connection catalogs before reading", () =>
    Effect.gen(function* () {
      const staleIntegration = IntegrationSlug.make("stale-manifest");
      const staleConnection = ConnectionName.make("main");
      const staleAddress = (tool: string): ToolAddress =>
        ToolAddress.make(`tools.${staleIntegration}.org.${staleConnection}.${tool}`);
      const versionedPlugin = definePlugin(() => ({
        id: "staleManifest" as const,
        credentialProviders: [memoryProvider()],
        storage: () => ({}),
        resolveTools: ({ config }) => {
          const version =
            config && typeof config === "object" && "version" in config
              ? String((config as { readonly version?: unknown }).version)
              : "unknown";
          return Effect.succeed({
            tools: [
              {
                name: ToolName.make("inspect"),
                description: `inspect ${version}`,
              },
            ],
            definitions: {},
            sourceRevision: version,
          });
        },
        invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
        extension: (ctx) => ({
          seed: () =>
            ctx.core.integrations.register({
              slug: staleIntegration,
              description: "Stale Manifest",
              config: { version: "v1" },
            }),
          revise: (version: string) =>
            ctx.core.integrations.update(staleIntegration, {
              config: { version },
            }),
        }),
      }))();

      const executor = yield* makeTestExecutor({
        plugins: [versionedPlugin] as const,
      });
      yield* executor.staleManifest.seed();
      yield* executor.connections.create({
        owner: "org",
        name: staleConnection,
        integration: staleIntegration,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
      });

      const before = yield* executor.tools.manifest({
        integration: staleIntegration,
        includeBlocked: true,
      });
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({
        address: staleAddress("inspect"),
        description: "inspect v1",
        sourceRevision: "v1",
      });

      yield* executor.staleManifest.revise("v2");

      const after = yield* executor.tools.manifest({
        integration: staleIntegration,
        includeBlocked: true,
      });
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        address: staleAddress("inspect"),
        description: "inspect v2",
        sourceRevision: "v2",
      });
    }),
  );

  it.effect("tools.manifest persists plugin-provided source revisions", () =>
    Effect.gen(function* () {
      const sourceRevision = "spec-hash-v1";
      const sourcePlugin = definePlugin(() => ({
        id: "sourceRevision" as const,
        credentialProviders: [memoryProvider()],
        storage: () => ({}),
        resolveTools: () =>
          Effect.succeed({
            tools: [{ name: ToolName.make("inspect"), description: "inspect" }],
            definitions: {},
            sourceRevision,
          }),
        invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
        extension: (ctx) => ({
          seed: () =>
            ctx.core.integrations.register({
              slug: INTEG,
              description: "Source",
              config: { fallback: "would-be-hashed" },
            }),
        }),
      }))();

      const executor = yield* makeTestExecutor({
        plugins: [sourcePlugin] as const,
      });
      yield* executor.sourceRevision.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
      });

      const manifest = (yield* executor.tools.manifest({
        integration: INTEG,
        includeBlocked: true,
      })).find((entry) => entry.name === "inspect");
      expect(manifest?.sourceRevision).toBe(sourceRevision);
    }),
  );

  it.effect("execute dispatches a connection-produced tool to the owning plugin", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      const out = yield* executor.execute(addr("run"), {});
      expect(out).toEqual({ ran: "run" });
    }),
  );

  it.effect("execute on a missing address fails with ToolNotFoundError", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [demoPlugin] as const,
      });
      yield* executor.demo.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("other"),
        integration: INTEG,
        template: TEMPLATE,
        from: {
          provider: ProviderKey.make("memory"),
          id: ProviderItemId.make("v"),
        },
      });

      const result = yield* Effect.result(executor.execute(addr("un"), {}));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      const error = result.failure;
      expect(Predicate.isTagged(error, "ToolNotFoundError")).toBe(true);
      const suggestions = (error as ToolNotFoundError).suggestions ?? [];
      expect(suggestions).toEqual([addr("run")]);
      expect(
        suggestions.every((suggestion) =>
          String(suggestion).startsWith(`tools.${INTEG}.org.${CONN}.`),
        ),
      ).toBe(true);
    }),
  );
});

describe("tools.list cache", () => {
  const names = (tools: readonly { readonly name: ToolName }[]): string[] =>
    tools.map((tool) => String(tool.name)).sort();

  const dynamicPlugin = (resolve: () => readonly { name: ToolName; description: string }[]) =>
    definePlugin(() => ({
      id: "listCache" as const,
      credentialProviders: [memoryProvider()],
      storage: () => ({}),
      resolveTools: () => Effect.succeed({ tools: resolve(), definitions: {} }),
      invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
      extension: (ctx) => ({
        seed: () =>
          ctx.core.integrations.register({ slug: INTEG, description: "Demo", config: {} }),
      }),
    }))();

  it.effect("reflects tool-set additions and removals across a refresh", () =>
    Effect.gen(function* () {
      let tools = [
        { name: ToolName.make("inspect"), description: "inspect" },
        { name: ToolName.make("run"), description: "run" },
      ];
      const executor = yield* makeTestExecutor({
        plugins: [dynamicPlugin(() => tools)] as const,
      });
      yield* executor.listCache.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
      });

      // Prime the cache.
      expect(names(yield* executor.tools.list({ integration: INTEG }))).toEqual(["inspect", "run"]);

      // Remove `inspect`, add `status` — a stale cache would still return [inspect, run].
      tools = [
        { name: ToolName.make("run"), description: "run" },
        { name: ToolName.make("status"), description: "status" },
      ];
      yield* executor.connections.refresh({ owner: "org", integration: INTEG, name: CONN });
      expect(names(yield* executor.tools.list({ integration: INTEG }))).toEqual(["run", "status"]);
    }),
  );

  it.effect("reflects a tool content change across a refresh", () =>
    Effect.gen(function* () {
      let description = "v1";
      const executor = yield* makeTestExecutor({
        plugins: [dynamicPlugin(() => [{ name: ToolName.make("inspect"), description }])] as const,
      });
      yield* executor.listCache.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
      });

      expect((yield* executor.tools.list({ integration: INTEG }))[0]?.description).toBe("v1");
      description = "v2";
      yield* executor.connections.refresh({ owner: "org", integration: INTEG, name: CONN });
      expect((yield* executor.tools.list({ integration: INTEG }))[0]?.description).toBe("v2");
    }),
  );

  it.effect("invalidates when a block policy is added", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [
          dynamicPlugin(() => [{ name: ToolName.make("inspect"), description: "inspect" }]),
        ] as const,
      });
      yield* executor.listCache.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
      });

      expect(names(yield* executor.tools.list({ integration: INTEG }))).toEqual(["inspect"]);
      // A stale cache would still surface the now-blocked tool.
      yield* executor.policies.create({ owner: "org", pattern: `${INTEG}.*`, action: "block" });
      expect(yield* executor.tools.list({ integration: INTEG })).toEqual([]);
    }),
  );

  it.effect("applies the query filter post-cache so distinct queries share a cached set", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        plugins: [
          dynamicPlugin(() => [
            { name: ToolName.make("inspect"), description: "inspect" },
            { name: ToolName.make("run"), description: "run" },
          ]),
        ] as const,
      });
      yield* executor.listCache.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: TEMPLATE,
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
      });

      expect(names(yield* executor.tools.list({ integration: INTEG, query: "inspect" }))).toEqual([
        "inspect",
      ]);
      expect(names(yield* executor.tools.list({ integration: INTEG, query: "run" }))).toEqual([
        "run",
      ]);
      expect(names(yield* executor.tools.list({ integration: INTEG }))).toEqual(["inspect", "run"]);
    }),
  );

  it.effect("unions static tools live on a cache hit", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools: { webBaseUrl: "http://localhost:3000" },
      });
      const first = yield* executor.tools.list({});
      const second = yield* executor.tools.list({});
      const addresses = (tools: readonly { readonly address: ToolAddress }[]) =>
        tools.map((tool) => String(tool.address)).sort();
      expect(addresses(first)).toEqual(addresses(second));
      expect(first.length).toBeGreaterThan(0);
      expect(first.some((tool) => tool.static === true)).toBe(true);
    }),
  );
});
