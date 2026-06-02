import { createClient, type Client } from "@libsql/client";
import { resolve } from "node:path";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { type FumaDB } from "fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
} from "fumadb/adapters/drizzle";
import { type schema as fumaSchema, type RelationsMap } from "fumadb/schema";

import { createExecutorFumaDb } from "@executor-js/api/server";
import type { FumaDb, FumaTables } from "@executor-js/sdk/core";

// ---------------------------------------------------------------------------
// libSQL-backed FumaDB SQLite store for the local single-user host.
//
// One on-disk SQLite file (under EXECUTOR_DATA_DIR, default ~/.executor) holds
// the whole executor: sources, tool catalogs, secret routing rows, connections.
// libSQL opens a connection (not a shared in-process handle), so the per-
// connection PRAGMAs (foreign_keys + WAL) are re-applied on open. The schema is
// brought up idempotently from the executor's table set (`collectTables()`),
// so a fresh data dir self-initializes on first boot — no migration tool.
//
// This is the minimal fresh-install store. The product `apps/local` additionally
// carries a legacy-SQLite import/upgrade pipeline (pre-FumaDB / pre-scope DBs);
// a scaffolded thin repo starts on FumaDB SQLite directly, so that machinery is
// intentionally omitted.
// ---------------------------------------------------------------------------

/**
 * Build a libSQL `file:` URL from a filesystem path. libSQL requires an absolute
 * path for `file:` URLs; `:memory:` passes through unchanged.
 */
export const toLibsqlFileUrl = (path: string): string =>
  path === ":memory:" ? path : `file:${resolve(path)}`;

/**
 * Open a libSQL client for the local on-disk DB and apply the per-connection
 * PRAGMAs (foreign_keys + WAL).
 */
export const openLocalLibsql = async (path: string): Promise<Client> => {
  const client = createClient({ url: toLibsqlFileUrl(path) });
  // foreign_keys is strictly per-connection; WAL is a file-level mode set on
  // first enabling. Re-apply both since libSQL gives no shared handle.
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA journal_mode = WAL");
  return client;
};

type SqliteFumaSchema<TTables extends FumaTables> = ReturnType<
  typeof fumaSchema<string, TTables, RelationsMap<TTables>>
>;

export interface SqliteFumaDb<TTables extends FumaTables = FumaTables> {
  readonly db: FumaDb<SqliteFumaSchema<TTables>>;
  readonly fuma: FumaDB<SqliteFumaSchema<TTables>[]>;
  readonly drizzle: LibSQLDatabase<Record<string, unknown>>;
  readonly client: Client;
  readonly close: () => Promise<void>;
}

export interface CreateSqliteFumaDbOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace: string;
  readonly version?: string;
  readonly path: string;
}

/**
 * Open (and idempotently bring up the schema of) the local FumaDB SQLite store.
 * The CREATE TABLE IF NOT EXISTS bring-up makes a fresh data dir self-initialize
 * on first boot.
 */
export const createSqliteFumaDb = async <const TTables extends FumaTables>(
  options: CreateSqliteFumaDbOptions<TTables>,
): Promise<SqliteFumaDb<TTables>> => {
  const version = options.version ?? "1.0.0";
  const client = await openLocalLibsql(options.path);

  const schema = createDrizzleRuntimeSchemaFromTables({
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "sqlite",
  });
  const drizzleDb = drizzle({ client, schema });

  for (const statement of createDrizzleRuntimeSchemaSqlFromTables({
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "sqlite",
  })) {
    await client.execute(statement);
  }

  // Defensive column add for libSQL files created before connection identity
  // overrides existed — the bring-up above is CREATE TABLE IF NOT EXISTS and
  // won't add a column to an already-created table. Idempotent.
  const connectionColumns = await client.execute("PRAGMA table_info('connection')");
  if (
    connectionColumns.rows.length > 0 &&
    !connectionColumns.rows.some((column) => column["name"] === "identity_override")
  ) {
    await client.execute("ALTER TABLE connection ADD COLUMN identity_override TEXT");
  }

  const { db, fuma } = createExecutorFumaDb(drizzleDb, {
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "sqlite",
  });

  return {
    db,
    fuma,
    drizzle: drizzleDb,
    client,
    close: async () => {
      client.close();
    },
  };
};
