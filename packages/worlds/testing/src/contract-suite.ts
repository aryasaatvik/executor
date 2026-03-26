import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ExecutorWorld,
  WorkspaceId,
  AccountId,
  ExecutionId,
  SourceId,
} from "@executor/control-plane";

const testWorkspaceId = "ws_test" as WorkspaceId;
const testAccountId = "acct_test" as AccountId;

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

/**
 * Run the full contract test suite against any ExecutorWorld implementation.
 * Validates that all port implementations behave correctly.
 */
export function runWorldContractTests(createWorld: () => ExecutorWorld) {
  let world: ExecutorWorld;

  describe("ExecutionStore", () => {
    beforeEach(() => {
      world = createWorld();
    });

    it("creates and retrieves an execution", async () => {
      const record = await run(
        world.executionStore.create({
          workspaceId: testWorkspaceId,
          accountId: testAccountId,
          code: "console.log('hello')",
        }),
      );
      expect(record.id).toBeTruthy();
      expect(record.status).toBe("pending");
      expect(record.code).toBe("console.log('hello')");

      const fetched = await run(
        world.executionStore.getById({
          executionId: record.id,
          workspaceId: testWorkspaceId,
        }),
      );
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(record.id);
    });

    it("lists executions by workspace", async () => {
      await run(
        world.executionStore.create({
          workspaceId: testWorkspaceId,
          accountId: testAccountId,
          code: "1",
        }),
      );
      await run(
        world.executionStore.create({
          workspaceId: testWorkspaceId,
          accountId: testAccountId,
          code: "2",
        }),
      );

      const list = await run(world.executionStore.list({ workspaceId: testWorkspaceId }));
      expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it("updates execution status", async () => {
      const record = await run(
        world.executionStore.create({
          workspaceId: testWorkspaceId,
          accountId: testAccountId,
          code: "test",
        }),
      );

      const updated = await run(
        world.executionStore.update({
          executionId: record.id,
          update: { status: "running", startedAt: Date.now() },
        }),
      );
      expect(updated.status).toBe("running");
      expect(updated.startedAt).not.toBeNull();
    });

    it("creates and lists steps", async () => {
      const record = await run(
        world.executionStore.create({
          workspaceId: testWorkspaceId,
          accountId: testAccountId,
          code: "test",
        }),
      );

      await run(
        world.executionStore.createStep({
          executionId: record.id,
          sequence: 1,
          kind: "tool_call",
          path: "test.tool",
          argsJson: "{}",
        }),
      );

      const steps = await run(world.executionStore.listSteps({ executionId: record.id }));
      expect(steps.length).toBe(1);
      expect(steps[0].path).toBe("test.tool");
    });

    it("creates and resolves interactions", async () => {
      const record = await run(
        world.executionStore.create({
          workspaceId: testWorkspaceId,
          accountId: testAccountId,
          code: "test",
        }),
      );

      const interaction = await run(
        world.executionStore.createInteraction({
          executionId: record.id,
          kind: "approval",
          purpose: "Test approval",
          payloadJson: "{}",
        }),
      );
      expect(interaction.status).toBe("pending");

      const pending = await run(
        world.executionStore.getPendingInteraction({ executionId: record.id }),
      );
      expect(pending).not.toBeNull();
      expect(pending!.id).toBe(interaction.id);

      const resolved = await run(
        world.executionStore.resolveInteraction({
          interactionId: interaction.id,
          responseJson: '{"approved": true}',
        }),
      );
      expect(resolved.status).toBe("resolved");
    });
  });

  describe("SourceStore", () => {
    beforeEach(() => {
      world = createWorld();
    });

    it("creates and retrieves a source", async () => {
      const source = await run(
        world.sourceStore.create({
          workspaceId: testWorkspaceId,
          source: {
            workspaceId: testWorkspaceId,
            name: "Test API",
            kind: "openapi",
            endpoint: "https://example.com/openapi.json",
            status: "draft",
            enabled: true,
            namespace: null,
            iconUrl: null,
            bindingVersion: 1,
            binding: {},
            importAuthPolicy: "none",
            importAuth: { kind: "none" },
            auth: { kind: "none" },
            sourceHash: null,
            lastError: null,
          } as Omit<import("@executor/control-plane").Source, "id" | "createdAt" | "updatedAt">,
        }),
      );
      expect(source.id).toBeTruthy();
      expect(source.name).toBe("Test API");

      const fetched = await run(
        world.sourceStore.getById({
          workspaceId: testWorkspaceId,
          sourceId: source.id,
        }),
      );
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe("Test API");
    });

    it("lists sources by workspace", async () => {
      await run(
        world.sourceStore.create({
          workspaceId: testWorkspaceId,
          source: {
            workspaceId: testWorkspaceId,
            name: "API 1",
            kind: "openapi",
            endpoint: "https://example.com/1",
            status: "draft",
            enabled: true,
            namespace: null,
            iconUrl: null,
            bindingVersion: 1,
            binding: {},
            importAuthPolicy: "none",
            importAuth: { kind: "none" },
            auth: { kind: "none" },
            sourceHash: null,
            lastError: null,
          } as Omit<import("@executor/control-plane").Source, "id" | "createdAt" | "updatedAt">,
        }),
      );

      const list = await run(world.sourceStore.list({ workspaceId: testWorkspaceId }));
      expect(list.length).toBeGreaterThanOrEqual(1);
    });

    it("removes a source", async () => {
      const source = await run(
        world.sourceStore.create({
          workspaceId: testWorkspaceId,
          source: {
            workspaceId: testWorkspaceId,
            name: "To Remove",
            kind: "openapi",
            endpoint: "https://example.com/remove",
            status: "draft",
            enabled: true,
            namespace: null,
            iconUrl: null,
            bindingVersion: 1,
            binding: {},
            importAuthPolicy: "none",
            importAuth: { kind: "none" },
            auth: { kind: "none" },
            sourceHash: null,
            lastError: null,
          } as Omit<import("@executor/control-plane").Source, "id" | "createdAt" | "updatedAt">,
        }),
      );

      const removed = await run(
        world.sourceStore.remove({
          workspaceId: testWorkspaceId,
          sourceId: source.id,
        }),
      );
      expect(removed).toBe(true);

      const after = await run(
        world.sourceStore.getById({
          workspaceId: testWorkspaceId,
          sourceId: source.id,
        }),
      );
      expect(after).toBeNull();
    });
  });

  describe("SecretStore", () => {
    beforeEach(() => {
      world = createWorld();
    });

    it("creates and lists secrets", async () => {
      const secret = await run(
        world.secretStore.create({
          name: "API_KEY",
          value: "sk-test-123",
          purpose: "auth_material",
        }),
      );
      expect(secret.id).toBeTruthy();
      expect(secret.name).toBe("API_KEY");

      const list = await run(world.secretStore.list());
      expect(list.length).toBeGreaterThanOrEqual(1);
    });

    it("resolves a secret value", async () => {
      const secret = await run(
        world.secretStore.create({
          name: "TOKEN",
          value: "secret-value",
          providerId: "test-provider",
        }),
      );

      const resolved = await run(
        world.secretStore.resolve({
          providerId: secret.providerId,
          handle: secret.handle,
        }),
      );
      expect(resolved).toBe("secret-value");
    });

    it("removes a secret", async () => {
      const secret = await run(
        world.secretStore.create({
          name: "TEMP",
          value: "temp-value",
        }),
      );

      const removed = await run(world.secretStore.remove({ id: secret.id }));
      expect(removed).toBe(true);
    });
  });

  describe("SemanticSearch", () => {
    beforeEach(() => {
      world = createWorld();
    });

    it("indexes and searches documents", async () => {
      await run(world.search.index({ id: "tool-1", text: "fetch user profile" }));
      await run(world.search.index({ id: "tool-2", text: "create payment" }));

      const results = await run(world.search.search({ query: "user" }));
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.id === "tool-1")).toBe(true);
    });

    it("removes indexed documents", async () => {
      await run(world.search.index({ id: "tool-3", text: "delete account" }));
      await run(world.search.remove({ id: "tool-3" }));

      const results = await run(world.search.search({ query: "delete" }));
      expect(results.some((r) => r.id === "tool-3")).toBe(false);
    });

    it("reports availability", async () => {
      const available = await run(world.search.isAvailable());
      expect(typeof available).toBe("boolean");
    });
  });

  describe("RuntimeRegistry", () => {
    beforeEach(() => {
      world = createWorld();
    });

    it("returns available runtimes", async () => {
      const kinds = await run(world.runtimes.available());
      expect(kinds.length).toBeGreaterThanOrEqual(1);
    });

    it("returns a default runtime kind", async () => {
      const kind = await run(world.runtimes.defaultKind());
      expect(typeof kind).toBe("string");
    });

    it("gets a runtime by kind", async () => {
      const kind = await run(world.runtimes.defaultKind());
      const runtime = await run(world.runtimes.get(kind));
      expect(runtime.kind).toBe(kind);
    });
  });

  describe("WorkspaceConfig", () => {
    beforeEach(() => {
      world = createWorld();
    });

    it("returns workspace and account IDs", async () => {
      const wsId = await run(world.config.getWorkspaceId());
      expect(typeof wsId).toBe("string");
      expect(wsId.length).toBeGreaterThan(0);

      const acctId = await run(world.config.getAccountId());
      expect(typeof acctId).toBe("string");
      expect(acctId.length).toBeGreaterThan(0);
    });
  });
}
