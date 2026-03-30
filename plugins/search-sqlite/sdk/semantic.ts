import { Database } from "bun:sqlite";
import type {
  SearchDocumentLike,
  SearchEmbedder,
  SearchReranker,
  SearchVectorBackend,
  SearchVectorMatch,
} from "@executor/platform-sdk/runtime";

const tokenize = (value: string): string[] =>
  value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const normalizeUnitVector = (vector: Float32Array): Float32Array => {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }

  if (norm <= 0) {
    return vector;
  }

  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = vector[index]! * scale;
  }
  return vector;
};

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const addFeature = (
  vector: Float32Array,
  feature: string,
  weight: number,
) => {
  const hash = hashString(feature);
  const index = hash % vector.length;
  const sign = (hash >>> 31) === 0 ? 1 : -1;
  vector[index] = (vector[index] ?? 0) + weight * sign;
};

const addTokenFeatures = (
  vector: Float32Array,
  value: string,
  prefix: string,
  weight: number,
) => {
  const tokens = tokenize(value);
  for (const token of tokens) {
    addFeature(vector, `${prefix}:${token}`, weight);
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    addFeature(vector, `${prefix}:${tokens[index]}_${tokens[index + 1]}`, weight * 0.6);
  }
};

const addCharacterTrigrams = (
  vector: Float32Array,
  value: string,
  prefix: string,
  weight: number,
) => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (normalized.length < 3) {
    return;
  }

  for (let index = 0; index <= normalized.length - 3; index += 1) {
    const trigram = normalized.slice(index, index + 3);
    if (trigram.includes(" ")) {
      continue;
    }
    addFeature(vector, `${prefix}:tri:${trigram}`, weight);
  }
};

const embeddingTextFromDocument = (document: SearchDocumentLike): string =>
  [
    document.title ?? "",
    document.description ?? "",
    document.protocol ?? "",
    document.method ?? "",
    document.pathTemplate ?? "",
    document.operationId ?? "",
    document.group ?? "",
    document.leaf ?? "",
    document.namespace,
    document.path,
    document.searchText,
    document.tags.join(" "),
  ]
    .filter(Boolean)
    .join(" ");

export const createHashEmbedder = (input?: {
  dimensions?: number;
}): SearchEmbedder => {
  const dimensions = Math.max(64, Math.floor(input?.dimensions ?? 256));

  const embedValue = (inputValue: {
    text: string;
    title?: string | null;
    description?: string | null;
    namespace?: string;
    path?: string;
    tags?: readonly string[];
  }): Float32Array => {
    const vector = new Float32Array(dimensions);

    addTokenFeatures(vector, inputValue.text, "text", 1.2);
    addCharacterTrigrams(vector, inputValue.text, "text", 0.12);

    if (inputValue.title) {
      addTokenFeatures(vector, inputValue.title, "title", 3);
      addCharacterTrigrams(vector, inputValue.title, "title", 0.2);
    }

    if (inputValue.description) {
      addTokenFeatures(vector, inputValue.description, "description", 1.5);
    }

    if (inputValue.namespace) {
      addTokenFeatures(vector, inputValue.namespace, "namespace", 2.2);
    }

    if (inputValue.path) {
      addTokenFeatures(vector, inputValue.path, "path", 2.4);
      addCharacterTrigrams(vector, inputValue.path, "path", 0.18);
    }

    for (const tag of inputValue.tags ?? []) {
      addTokenFeatures(vector, tag, "tag", 2.4);
    }

    return normalizeUnitVector(vector);
  };

  return {
    key: "hash-v1",
    dimensions,
    embedDocument: (document) =>
      embedValue({
        text: embeddingTextFromDocument(document),
        title: document.title,
        description: document.description,
        namespace: document.namespace,
        path: document.path,
        tags: document.tags,
      }),
    embedQuery: (query) =>
      embedValue({
        text: query,
        title: query,
      }),
  };
};

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
