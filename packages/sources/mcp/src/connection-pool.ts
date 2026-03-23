import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import type { McpConnection, McpConnector } from "./tools";

export class McpConnectionPoolError extends Data.TaggedError("McpConnectionPoolError")<{
  readonly operation: "connect" | "close";
  readonly message: string;
  readonly cause: unknown;
}> {}

type PoolEntry = {
  scope: Scope.CloseableScope;
  connection: McpConnector;
};

type PoolEntryHandle = Promise<PoolEntry>;

const pooledRuns = new Map<string, Map<string, PoolEntryHandle>>();
const pooledSessions = new Map<string, SessionPoolEntry>();

export const MCP_SESSION_IDLE_TTL_MS = 15 * 60 * 1000;

export type McpConnectionSessionOwner = {
  workspaceId: string;
  accountId: string;
  executionSessionId: string;
};

type SessionPoolEntry = {
  lastUsedAt: number;
  sources: Map<string, PoolEntryHandle>;
};

const mcpConnectionPoolError = (input: {
  operation: "connect" | "close";
  message: string;
  cause: unknown;
}): McpConnectionPoolError => new McpConnectionPoolError(input);

const sessionPoolKey = (input: McpConnectionSessionOwner): string =>
  `${input.workspaceId}:${input.accountId}:${input.executionSessionId}`;

const deletePoolEntry = (
  runId: string,
  sourceKey: string,
  entry: PoolEntryHandle,
) => {
  const runEntries = pooledRuns.get(runId);
  if (!runEntries || runEntries.get(sourceKey) !== entry) {
    return;
  }

  runEntries.delete(sourceKey);
  if (runEntries.size === 0) {
    pooledRuns.delete(runId);
  }
};

const deleteSessionPoolEntry = (
  owner: McpConnectionSessionOwner,
  sourceKey: string,
  entry: PoolEntryHandle,
) => {
  const sessionEntry = pooledSessions.get(sessionPoolKey(owner));
  if (!sessionEntry || sessionEntry.sources.get(sourceKey) !== entry) {
    return;
  }

  sessionEntry.sources.delete(sourceKey);
  if (sessionEntry.sources.size === 0) {
    pooledSessions.delete(sessionPoolKey(owner));
  }
};

const closePooledConnection = (
  connection: McpConnection,
): Effect.Effect<void, never, never> =>
  Effect.tryPromise({
    try: () => Promise.resolve(connection.close?.()),
    catch: (cause) =>
      mcpConnectionPoolError({
        operation: "close",
        message: "Failed closing pooled MCP connection",
        cause,
      }),
  }).pipe(Effect.ignore);

const createPoolEntry = (
  connect: McpConnector,
): Effect.Effect<PoolEntry, McpConnectionPoolError, never> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const connection = yield* Effect.cached(
      Effect.acquireRelease(
        connect.pipe(
          Effect.mapError((cause) =>
            mcpConnectionPoolError({
              operation: "connect",
              message: "Failed creating pooled MCP connection",
              cause,
            })),
        ),
        closePooledConnection,
      ).pipe(Scope.extend(scope)),
    );

    return {
      scope,
      connection,
    };
  });

const touchSessionPool = (owner: McpConnectionSessionOwner, now: number) => {
  const entry = pooledSessions.get(sessionPoolKey(owner));
  if (entry) {
    entry.lastUsedAt = now;
  }
};

const getOrCreatePoolEntry = (input: {
  runId: string;
  sourceKey: string;
  connect: McpConnector;
}): PoolEntryHandle => {
  const existing = pooledRuns.get(input.runId)?.get(input.sourceKey);
  if (existing) {
    return existing;
  }

  let runEntries = pooledRuns.get(input.runId);
  if (!runEntries) {
    runEntries = new Map<string, PoolEntryHandle>();
    pooledRuns.set(input.runId, runEntries);
  }

  const entry = Effect.runPromise(createPoolEntry(input.connect));
  runEntries.set(input.sourceKey, entry);
  return entry;
};

const getOrCreateSessionPoolEntry = (input: {
  owner: McpConnectionSessionOwner;
  sourceKey: string;
  connect: McpConnector;
  now: number;
}): PoolEntryHandle => {
  const key = sessionPoolKey(input.owner);
  const existingSession = pooledSessions.get(key);
  const existing = existingSession?.sources.get(input.sourceKey);
  if (
    existing
    && existingSession
    && input.now - existingSession.lastUsedAt < MCP_SESSION_IDLE_TTL_MS
  ) {
    existingSession.lastUsedAt = input.now;
    return existing;
  }

  if (
    existingSession
    && input.now - existingSession.lastUsedAt >= MCP_SESSION_IDLE_TTL_MS
  ) {
    pooledSessions.delete(key);
    void Effect.runPromise(closeSessionPoolEntries(existingSession.sources));
  }

  const sessionEntry = pooledSessions.get(key) ?? {
    lastUsedAt: input.now,
    sources: new Map<string, PoolEntryHandle>(),
  };
  pooledSessions.set(key, sessionEntry);
  sessionEntry.lastUsedAt = input.now;

  const entry = Effect.runPromise(createPoolEntry(input.connect));
  sessionEntry.sources.set(input.sourceKey, entry);
  return entry;
};

const closePoolEntry = (entry: PoolEntry): Effect.Effect<void, never, never> =>
  Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

const closeSessionPoolEntries = (
  entries: Map<string, PoolEntryHandle>,
): Effect.Effect<void, never, never> =>
  Effect.forEach([...entries.values()], closePoolEntryHandle, {
    discard: true,
  });

const closePoolEntryHandle = (
  entry: PoolEntryHandle,
): Effect.Effect<void, never, never> =>
  Effect.promise(() => entry).pipe(
    Effect.flatMap(closePoolEntry),
    Effect.catchAll(() => Effect.void),
  );

const clearMcpConnectionPoolRunSource = (input: {
  runId: string;
  sourceKey: string;
}): Effect.Effect<void, never, never> => {
  const runEntries = pooledRuns.get(input.runId);
  const entry = runEntries?.get(input.sourceKey);
  if (!runEntries || !entry) {
    return Effect.void;
  }

  runEntries.delete(input.sourceKey);
  if (runEntries.size === 0) {
    pooledRuns.delete(input.runId);
  }

  return closePoolEntryHandle(entry);
};

const clearMcpConnectionPoolSessionSource = (input: {
  owner: McpConnectionSessionOwner;
  sourceKey: string;
}): Effect.Effect<void, never, never> => {
  const key = sessionPoolKey(input.owner);
  const sessionEntry = pooledSessions.get(key);
  const entry = sessionEntry?.sources.get(input.sourceKey);
  if (!sessionEntry || !entry) {
    return Effect.void;
  }

  sessionEntry.sources.delete(input.sourceKey);
  if (sessionEntry.sources.size === 0) {
    pooledSessions.delete(key);
  }

  return closePoolEntryHandle(entry);
};

const sweepExpiredSessionPools = (now: number): Effect.Effect<void, never, never> => {
  const expired = [...pooledSessions.entries()]
    .filter(([, entry]) => now - entry.lastUsedAt >= MCP_SESSION_IDLE_TTL_MS);

  for (const [key] of expired) {
    pooledSessions.delete(key);
  }

  return Effect.forEach(
    expired.map(([, entry]) => entry.sources),
    closeSessionPoolEntries,
    { discard: true },
  );
};

export const createPooledMcpConnector = (input: {
  connect: McpConnector;
  runId?: string;
  sessionOwner?: McpConnectionSessionOwner;
  sourceKey?: string;
}): McpConnector => {
  if (!input.sourceKey || (!input.runId && !input.sessionOwner)) {
    return input.connect;
  }

  return Effect.gen(function* () {
    const now = Date.now();
    yield* sweepExpiredSessionPools(now);
    const entryHandle = input.sessionOwner
      ? getOrCreateSessionPoolEntry({
          owner: input.sessionOwner,
          sourceKey: input.sourceKey!,
          connect: input.connect,
          now,
        })
      : getOrCreatePoolEntry({
          runId: input.runId!,
          sourceKey: input.sourceKey!,
          connect: input.connect,
        });
    const entry = yield* Effect.tryPromise({
      try: () => entryHandle,
      catch: (cause) =>
        mcpConnectionPoolError({
          operation: "connect",
          message: "Failed creating pooled MCP connection",
          cause,
        }),
    });
    const connection = yield* entry.connection.pipe(
      Effect.tapError(() =>
        (input.sessionOwner
          ? Effect.sync(() => {
              deleteSessionPoolEntry(input.sessionOwner!, input.sourceKey!, entryHandle);
            })
          : input.runId
            ? Effect.sync(() => {
                deletePoolEntry(input.runId!, input.sourceKey!, entryHandle);
              })
            : Effect.void).pipe(
          Effect.zipRight(closePoolEntry(entry)),
        )),
    );
    if (input.sessionOwner) {
      touchSessionPool(input.sessionOwner, now);
    }
    return {
      client: connection.client,
      close: async () => undefined,
      invalidate: async () => {
        if (input.sessionOwner) {
          await Effect.runPromise(
            clearMcpConnectionPoolSessionSource({
              owner: input.sessionOwner,
              sourceKey: input.sourceKey!,
            }).pipe(Effect.asVoid),
          );
          return;
        }

        if (input.runId) {
          await Effect.runPromise(
            clearMcpConnectionPoolRunSource({
              runId: input.runId,
              sourceKey: input.sourceKey!,
            }).pipe(Effect.asVoid),
          );
        }
      },
    };
  });
};

export const clearMcpConnectionPoolRun = (
  runId: string,
): Effect.Effect<void, never, never> => {
  const runEntries = pooledRuns.get(runId);
  if (!runEntries) {
    return Effect.void;
  }

  pooledRuns.delete(runId);
  return Effect.forEach([...runEntries.values()], closePoolEntryHandle, {
    discard: true,
  });
};

export const clearMcpConnectionPoolSession = (
  owner: McpConnectionSessionOwner,
): Effect.Effect<void, never, never> => {
  const key = sessionPoolKey(owner);
  const sessionEntry = pooledSessions.get(key);
  if (!sessionEntry) {
    return Effect.void;
  }

  pooledSessions.delete(key);
  return closeSessionPoolEntries(sessionEntry.sources);
};

export const clearAllMcpConnectionPools = (): Effect.Effect<void, never, never> => {
  const runEntries = [...pooledRuns.values()].flatMap((entries) => [...entries.values()]);
  const sessionEntries = [...pooledSessions.values()].flatMap((entry) => [...entry.sources.values()]);
  pooledRuns.clear();
  pooledSessions.clear();
  return Effect.forEach([...runEntries, ...sessionEntries], closePoolEntryHandle, {
    discard: true,
  });
};

export const sweepIdleMcpConnectionPools = (
  now: number = Date.now(),
): Effect.Effect<void, never, never> => sweepExpiredSessionPools(now);
