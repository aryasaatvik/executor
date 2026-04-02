import { Database } from "bun:sqlite";
import type {
  SearchReranker,
  SearchVectorBackend,
  SearchVectorMatch,
} from "@executor/platform-sdk/runtime";

const resolveSqliteVecLoad = async (
  db: Database,
  extensionPath?: string,
): Promise<string> => {
  const sqliteVec = await import("sqlite-vec");
  const explicitPath = extensionPath?.trim() ? extensionPath.trim() : null;

  db.loadExtension(
    explicitPath
      ?? (typeof sqliteVec.getLoadablePath === "function"
        ? sqliteVec.getLoadablePath()
        : ""),
  );

  return explicitPath
    ?? (typeof sqliteVec.getLoadablePath === "function"
      ? sqliteVec.getLoadablePath()
      : "sqlite-vec");
};

const configureBunSqliteForExtensions = () => {
  const candidatePaths = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ];

  for (const candidatePath of candidatePaths) {
    try {
      Database.setCustomSQLite(candidatePath);
      return;
    } catch {
      // Try the next candidate.
    }
  }
};

const ensureVectorTable = (
  db: Database,
  tableName: string,
  dimensions: number,
): boolean => {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
  ).get(tableName) as { sql?: string } | null;
  let rebuilt = false;

  if (row?.sql) {
    const match = row.sql.match(/float\[(\d+)\]/);
    const currentDimensions = match?.[1] ? Number(match[1]) : null;
    if (currentDimensions === dimensions && row.sql.includes("distance_metric=cosine")) {
      return false;
    }
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    rebuilt = true;
  } else {
    rebuilt = true;
  }

  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(id TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`,
  );
  return rebuilt;
};

export const createSqliteVecBackend = (input: {
  db: () => Database;
  tableName: string;
  dimensions: number;
  extensionPath?: string;
}): SearchVectorBackend => {
  let available = false;
  let statusDetail: string | null = null;
  let rebuildRequired = false;

  const ensureReady = () => {
    if (!available) {
      throw new Error(statusDetail ?? "sqlite-vec is unavailable");
    }

    const db = input.db();
    rebuildRequired ||= ensureVectorTable(db, input.tableName, input.dimensions);
    return db;
  };

  return {
    key: "sqlite-vec",
    init: async () => {
      try {
        configureBunSqliteForExtensions();
        const db = input.db();
        const loadablePath = await resolveSqliteVecLoad(db, input.extensionPath);
        rebuildRequired ||= ensureVectorTable(db, input.tableName, input.dimensions);
        available = true;
        statusDetail = loadablePath;
      } catch (cause) {
        available = false;
        statusDetail = cause instanceof Error ? cause.message : String(cause);
      }
    },
    isAvailable: () => available,
    detail: () => statusDetail,
    isRebuildRequired: () => rebuildRequired,
    markRebuilt: () => {
      rebuildRequired = false;
    },
    upsert: (records) => {
      if (records.length === 0 || !available) {
        return;
      }

      const db = ensureReady();
      const insert = db.prepare(
        `INSERT OR REPLACE INTO ${input.tableName} (id, embedding) VALUES (?, ?)`,
      );

      db.exec("BEGIN IMMEDIATE TRANSACTION;");
      try {
        for (const record of records) {
          insert.run(record.id, record.embedding);
        }
        db.exec("COMMIT;");
      } catch (cause) {
        db.exec("ROLLBACK;");
        throw cause;
      }
    },
    removeByIds: (ids) => {
      if (ids.length === 0 || !available) {
        return;
      }

      const db = ensureReady();
      const remove = db.prepare(`DELETE FROM ${input.tableName} WHERE id = ?`);
      db.exec("BEGIN IMMEDIATE TRANSACTION;");
      try {
        for (const id of ids) {
          remove.run(id);
        }
        db.exec("COMMIT;");
      } catch (cause) {
        db.exec("ROLLBACK;");
        throw cause;
      }
    },
    search: ({ embedding, limit }) => {
      if (!available || limit <= 0) {
        return [];
      }

      const db = ensureReady();
      return db.prepare(
        `SELECT id, distance FROM ${input.tableName} WHERE embedding MATCH ? AND k = ?`,
      ).all(embedding, limit) as SearchVectorMatch[];
    },
    rebuild: (records) => {
      if (!available) {
        return;
      }

      const db = ensureReady();
      db.exec(`DROP TABLE IF EXISTS ${input.tableName}`);
      ensureVectorTable(db, input.tableName, input.dimensions);
      if (records.length > 0) {
        const insert = db.prepare(
          `INSERT OR REPLACE INTO ${input.tableName} (id, embedding) VALUES (?, ?)`,
        );
        db.exec("BEGIN IMMEDIATE TRANSACTION;");
        try {
          for (const record of records) {
            insert.run(record.id, record.embedding);
          }
          db.exec("COMMIT;");
        } catch (cause) {
          db.exec("ROLLBACK;");
          throw cause;
        }
      }
      rebuildRequired = false;
    },
  };
};

export const createScoreFusionReranker = (): SearchReranker => ({
  key: "rrf-v1",
  rerank: ({ candidates }) =>
    [...candidates].sort((left, right) =>
      right.score - left.score
      || right.lexicalScore - left.lexicalScore
      || (left.id.localeCompare(right.id))),
});
