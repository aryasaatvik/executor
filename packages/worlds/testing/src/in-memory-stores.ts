import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  ExecutionStoreShape,
  SourceStoreShape,
  CatalogStoreShape,
  SecretStoreShape,
  AuthArtifactStoreShape,
  SemanticSearchShape,
  InteractionBusShape,
  RuntimeRegistryShape,
  WorkspaceConfigShape,
  ExecutionRecord,
  ExecutionInteraction,
  ExecutionStep,
  Source,
  SecretMaterial,
  AuthArtifact,
  AuthLease,
  StoredSourceCatalogRecord,
  ToolSearchResultSet,
  ExecutionId,
  WorkspaceId,
  AccountId,
} from "@executor/control-plane";
import type { RuntimeKind, ExecutionRuntime } from "@executor/execution-contract";

let counter = 0;
const nextId = (prefix: string): string => `${prefix}_${++counter}`;

// ---------------------------------------------------------------------------
// ExecutionStore
// ---------------------------------------------------------------------------

export const createInMemoryExecutionStore = (): ExecutionStoreShape => {
  const executions = new Map<string, ExecutionRecord>();
  const interactions = new Map<string, ExecutionInteraction>();
  const steps = new Map<string, ExecutionStep>();

  return {
    create: (input) =>
      Effect.sync(() => {
        const now = Date.now();
        const record: ExecutionRecord = {
          id: nextId("exec") as ExecutionRecord["id"],
          workspaceId: input.workspaceId,
          createdByAccountId: input.accountId,
          executionSessionId: input.executionSessionId ?? null,
          status: "pending",
          code: input.code,
          resultJson: null,
          errorText: null,
          logsJson: null,
          startedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        executions.set(record.id, record);
        return record;
      }),

    getById: (input) =>
      Effect.sync(() => {
        const record = executions.get(input.executionId);
        return record && record.workspaceId === input.workspaceId ? record : null;
      }),

    list: (input) =>
      Effect.sync(() =>
        [...executions.values()].filter((r) => r.workspaceId === input.workspaceId),
      ),

    update: (input) =>
      Effect.sync(() => {
        const existing = executions.get(input.executionId);
        if (!existing) throw new Error(`Execution not found: ${input.executionId}`);
        const updated: ExecutionRecord = { ...existing, ...input.update, updatedAt: Date.now() };
        executions.set(input.executionId, updated);
        return updated;
      }),

    createInteraction: (input) =>
      Effect.sync(() => {
        const now = Date.now();
        const interaction: ExecutionInteraction = {
          id: nextId("intr") as ExecutionInteraction["id"],
          executionId: input.executionId,
          status: "pending",
          kind: input.kind,
          purpose: input.purpose,
          payloadJson: input.payloadJson,
          responseJson: null,
          responsePrivateJson: null,
          createdAt: now,
          updatedAt: now,
        };
        interactions.set(interaction.id, interaction);
        return interaction;
      }),

    resolveInteraction: (input) =>
      Effect.sync(() => {
        const existing = interactions.get(input.interactionId);
        if (!existing) throw new Error(`Interaction not found: ${input.interactionId}`);
        const updated: ExecutionInteraction = {
          ...existing,
          status: "resolved",
          responseJson: input.responseJson ?? null,
          responsePrivateJson: input.responsePrivateJson ?? null,
          updatedAt: Date.now(),
        };
        interactions.set(input.interactionId, updated);
        return updated;
      }),

    getPendingInteraction: (input) =>
      Effect.sync(() =>
        [...interactions.values()].find(
          (i) => i.executionId === input.executionId && i.status === "pending",
        ) ?? null,
      ),

    createStep: (input) =>
      Effect.sync(() => {
        const now = Date.now();
        const step: ExecutionStep = {
          id: nextId("step") as ExecutionStep["id"],
          executionId: input.executionId,
          sequence: input.sequence,
          kind: input.kind,
          status: "pending",
          path: input.path,
          argsJson: input.argsJson,
          resultJson: null,
          errorText: null,
          interactionId: null,
          createdAt: now,
          updatedAt: now,
        };
        steps.set(step.id, step);
        return step;
      }),

    updateStep: (input) =>
      Effect.sync(() => {
        const existing = steps.get(input.stepId);
        if (!existing) throw new Error(`Step not found: ${input.stepId}`);
        const updated: ExecutionStep = { ...existing, ...input.update, updatedAt: Date.now() };
        steps.set(input.stepId, updated);
        return updated;
      }),

    listSteps: (input) =>
      Effect.sync(() =>
        [...steps.values()]
          .filter((s) => s.executionId === input.executionId)
          .sort((a, b) => a.sequence - b.sequence),
      ),
  };
};

// ---------------------------------------------------------------------------
// SourceStore
// ---------------------------------------------------------------------------

export const createInMemorySourceStore = (): SourceStoreShape => {
  const sources = new Map<string, Source>();

  return {
    list: (input) =>
      Effect.sync(() =>
        [...sources.values()].filter((s) => s.workspaceId === input.workspaceId),
      ),

    getById: (input) =>
      Effect.sync(() => {
        const source = sources.get(input.sourceId);
        return source && source.workspaceId === input.workspaceId ? source : null;
      }),

    create: (input) =>
      Effect.sync(() => {
        const now = Date.now();
        const source: Source = {
          ...input.source,
          id: nextId("src") as Source["id"],
          createdAt: now,
          updatedAt: now,
        } as Source;
        sources.set(source.id, source);
        return source;
      }),

    update: (input) =>
      Effect.sync(() => {
        const existing = sources.get(input.sourceId);
        if (!existing || existing.workspaceId !== input.workspaceId) {
          throw new Error(`Source not found: ${input.sourceId}`);
        }
        const updated: Source = { ...existing, ...input.update, id: existing.id, updatedAt: Date.now() } as Source;
        sources.set(input.sourceId, updated);
        return updated;
      }),

    remove: (input) =>
      Effect.sync(() => {
        const existing = sources.get(input.sourceId);
        if (!existing || existing.workspaceId !== input.workspaceId) return false;
        sources.delete(input.sourceId);
        return true;
      }),
  };
};

// ---------------------------------------------------------------------------
// CatalogStore
// ---------------------------------------------------------------------------

export const createInMemoryCatalogStore = (): CatalogStoreShape => ({
  getCatalogForSource: (_input) => Effect.succeed(null),
  syncCatalog: (input) =>
    Effect.fail(new Error(`In-memory catalog sync not implemented for ${input.sourceId}`)),
  searchTools: (_payload) =>
    Effect.succeed({ results: [], meta: { mode: "keyword", total: 0 } } as unknown as ToolSearchResultSet),
});

// ---------------------------------------------------------------------------
// SecretStore
// ---------------------------------------------------------------------------

export const createInMemorySecretStore = (): SecretStoreShape => {
  const secrets = new Map<string, SecretMaterial & { rawValue: string }>();

  return {
    list: () =>
      Effect.sync(() => [...secrets.values()].map(({ rawValue: _, ...s }) => s)),

    getByHandle: (input) =>
      Effect.sync(() => {
        for (const s of secrets.values()) {
          if (s.providerId === input.providerId && s.handle === input.handle) {
            const { rawValue: _, ...rest } = s;
            return rest;
          }
        }
        return null;
      }),

    resolve: (input) =>
      Effect.sync(() => {
        for (const s of secrets.values()) {
          if (s.providerId === input.providerId && s.handle === input.handle) {
            return s.rawValue;
          }
        }
        return null;
      }),

    create: (input) =>
      Effect.sync(() => {
        const now = Date.now();
        const id = nextId("secret");
        const handle = input.name;
        const entry = {
          id: id as SecretMaterial["id"],
          name: input.name,
          purpose: input.purpose ?? ("auth_material" as const),
          providerId: input.providerId ?? "local",
          handle,
          value: null,
          createdAt: now,
          updatedAt: now,
          rawValue: input.value,
        };
        secrets.set(id, entry);
        const { rawValue: _, ...result } = entry;
        return result;
      }),

    update: (input) =>
      Effect.sync(() => {
        const existing = secrets.get(input.id);
        if (!existing) throw new Error(`Secret not found: ${input.id}`);
        const updated = {
          ...existing,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.value !== undefined ? { rawValue: input.value } : {}),
          updatedAt: Date.now(),
        };
        secrets.set(input.id, updated);
        const { rawValue: _, ...result } = updated;
        return result;
      }),

    remove: (input) =>
      Effect.sync(() => secrets.delete(input.id)),
  };
};

// ---------------------------------------------------------------------------
// AuthArtifactStore
// ---------------------------------------------------------------------------

export const createInMemoryAuthArtifactStore = (): AuthArtifactStoreShape => {
  const artifacts = new Map<string, AuthArtifact>();
  const leases = new Map<string, AuthLease>();

  return {
    getArtifact: (input) =>
      Effect.sync(() => {
        for (const a of artifacts.values()) {
          if (
            a.workspaceId === input.workspaceId
            && a.sourceId === input.sourceId
            && a.slot === input.slot
          ) {
            return a;
          }
        }
        return null;
      }),

    upsertArtifact: (input) =>
      Effect.sync(() => {
        const now = Date.now();
        const id = nextId("auth_artifact");
        const artifact: AuthArtifact = {
          ...input.artifact,
          id: id as AuthArtifact["id"],
          createdAt: now,
          updatedAt: now,
        } as AuthArtifact;
        artifacts.set(id, artifact);
        return artifact;
      }),

    removeArtifact: (input) =>
      Effect.sync(() => artifacts.delete(input.artifactId)),

    acquireLease: (input) =>
      Effect.sync(() => {
        const now = Date.now();
        const lease: AuthLease = {
          id: nextId("lease") as AuthLease["id"],
          authArtifactId: input.artifact.id,
          workspaceId: input.artifact.workspaceId,
          sourceId: input.artifact.sourceId,
          actorAccountId: input.artifact.actorAccountId,
          slot: input.artifact.slot,
          placementsTemplateJson: "{}",
          expiresAt: null,
          refreshAfter: null,
          createdAt: now,
          updatedAt: now,
        };
        leases.set(lease.id, lease);
        return lease;
      }),

    releaseLease: (input) =>
      Effect.sync(() => leases.delete(input.leaseId)),
  };
};

// ---------------------------------------------------------------------------
// SemanticSearch
// ---------------------------------------------------------------------------

export const createInMemorySemanticSearch = (): SemanticSearchShape => {
  const docs = new Map<string, { text: string; metadata?: Record<string, string> }>();

  return {
    index: (input) =>
      Effect.sync(() => {
        docs.set(input.id, { text: input.text, metadata: input.metadata });
      }),

    search: (input) =>
      Effect.sync(() => {
        const query = input.query.toLowerCase();
        const limit = input.limit ?? 10;
        return [...docs.entries()]
          .map(([id, doc]) => ({
            id,
            score: doc.text.toLowerCase().includes(query) ? 1.0 : 0.0,
          }))
          .filter((hit) => hit.score > 0)
          .slice(0, limit);
      }),

    remove: (input) =>
      Effect.sync(() => {
        docs.delete(input.id);
      }),

    isAvailable: () => Effect.succeed(true),
  };
};

// ---------------------------------------------------------------------------
// InteractionBus
// ---------------------------------------------------------------------------

export const createInMemoryInteractionBus = (): InteractionBusShape => {
  const listeners = new Map<string, Set<(interaction: ExecutionInteraction) => void>>();
  const resolved = new Map<string, ExecutionInteraction>();

  return {
    publish: (input) =>
      Effect.sync(() => {
        const subs = listeners.get(input.executionId);
        if (subs) {
          for (const cb of subs) cb(input.interaction);
        }
        if (input.interaction.status === "resolved") {
          resolved.set(input.interaction.id, input.interaction);
        }
      }),

    subscribe: (input) =>
      Effect.sync(() => {
        if (!listeners.has(input.executionId)) {
          listeners.set(input.executionId, new Set());
        }
        const subs = listeners.get(input.executionId)!;
        subs.add(input.onInteraction);
        return {
          unsubscribe: () => {
            subs.delete(input.onInteraction);
          },
        };
      }),

    waitForResolution: (input) =>
      Effect.async<ExecutionInteraction, Error>((resume) => {
        const existing = resolved.get(input.interactionId);
        if (existing) {
          resume(Effect.succeed(existing));
          return;
        }

        if (!listeners.has(input.executionId)) {
          listeners.set(input.executionId, new Set());
        }
        const subs = listeners.get(input.executionId)!;
        const handler = (interaction: ExecutionInteraction) => {
          if (interaction.id === input.interactionId && interaction.status === "resolved") {
            subs.delete(handler);
            resume(Effect.succeed(interaction));
          }
        };
        subs.add(handler);
      }),
  };
};

// ---------------------------------------------------------------------------
// RuntimeRegistry
// ---------------------------------------------------------------------------

export const createInMemoryRuntimeRegistry = (): RuntimeRegistryShape => {
  const stubRuntime: ExecutionRuntime = {
    kind: "quickjs",
    requirements: { isolation: "vm", networkAccess: false, fileSystemAccess: false },
    prepare: (input) =>
      Effect.succeed({ id: nextId("session"), runtimeKind: "quickjs" as const }),
    start: (_session) =>
      Stream.make({
        _tag: "ErrorEvent" as const,
        error: "In-memory stub runtime",
        timestamp: Date.now(),
      }),
    stop: (_handle) => Effect.void,
  };

  return {
    get: (_kind) => Effect.succeed(stubRuntime),
    available: () => Effect.succeed(["quickjs" as RuntimeKind]),
    defaultKind: () => Effect.succeed("quickjs" as RuntimeKind),
  };
};

// ---------------------------------------------------------------------------
// WorkspaceConfig
// ---------------------------------------------------------------------------

export const createInMemoryWorkspaceConfig = (): WorkspaceConfigShape => ({
  getWorkspaceId: () => Effect.succeed("test-workspace" as WorkspaceId),
  getAccountId: () => Effect.succeed("test-account" as AccountId),
});
