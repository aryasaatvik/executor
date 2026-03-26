import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type LoadMonorepoRootEnvOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const parseEnvFile = (content: string): Record<string, string> => {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(rawLine);
    if (!match) {
      continue;
    }

    const key = match[1]!;
    let value = match[2] ?? "";
    value = value.trim();

    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0]!;
      value = value.slice(1, -1);
      if (quote === "\"") {
        value = value
          .replace(/\\n/gu, "\n")
          .replace(/\\r/gu, "\r")
          .replace(/\\t/gu, "\t")
          .replace(/\\"/gu, "\"")
          .replace(/\\\\/gu, "\\");
      }
    } else {
      value = value.replace(/\s+#.*$/u, "");
    }

    values[key] = value;
  }

  return values;
};

const isWorkspaceRoot = (directory: string): boolean => {
  const packageJsonPath = join(directory, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      workspaces?: unknown;
    };
    return Array.isArray(parsed.workspaces);
  } catch {
    return false;
  }
};

const findMonorepoRoot = (startDir: string): string | null => {
  let current = resolve(startDir);

  while (true) {
    if (isWorkspaceRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
};

export const loadMonorepoRootEnv = (
  options: LoadMonorepoRootEnvOptions = {},
): { rootDir: string | null; loadedFiles: string[] } => {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const rootDir = findMonorepoRoot(cwd);
  if (rootDir === null) {
    return {
      rootDir: null,
      loadedFiles: [],
    };
  }

  const initialKeys = new Set(Object.keys(env));
  const loadedFiles: string[] = [];

  for (const fileName of [".env", ".env.local"]) {
    const filePath = join(rootDir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    const parsed = parseEnvFile(readFileSync(filePath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (initialKeys.has(key)) {
        continue;
      }
      env[key] = value;
    }
    loadedFiles.push(filePath);
  }

  return {
    rootDir,
    loadedFiles,
  };
};

