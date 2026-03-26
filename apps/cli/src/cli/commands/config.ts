import { defineCommand, defineGroup, option } from "@bunli/core";
import {
  loadLocalExecutorConfig,
  mergeLocalExecutorConfigs,
  type LoadedLocalExecutorConfig,
  resolveLocalWorkspaceContext,
  type ResolvedLocalWorkspaceContext,
  writeHomeLocalExecutorConfig,
  writeProjectLocalExecutorConfig,
  type LocalExecutorConfig,
} from "@executor/engine";
import * as Effect from "effect/Effect";
import { z } from "zod";

import { executorAppEffectError } from "../../effect-errors";
import {
  printJson,
  printText,
  runCliEffect,
} from "../core";

type ConfigScope = "effective" | "global" | "workspace";
type ConfigWorkspaceState = {
  context: ResolvedLocalWorkspaceContext;
  loaded: LoadedLocalExecutorConfig;
};

const scopeFlags = {
  global: option(z.coerce.boolean().default(false), {
    description: "Operate on the home config file",
  }),
  workspace: option(z.coerce.boolean().default(false), {
    description: "Operate on the workspace config file",
  }),
};

const jsonFlag = option(z.coerce.boolean().default(false), {
  description: "Print machine-readable output",
});

const knownRoots = new Set([
  "runtime",
  "workspace",
  "daemon",
  "call",
  "search",
  "semanticSearch",
  "sources",
  "secrets",
]);

const semanticSearchKeys = new Set([
  "provider",
  "model",
  "apiKeyRef",
  "dimensions",
]);

const daemonKeys = new Set(["baseUrl", "port"]);
const callKeys = new Set(["baseUrl", "noOpen"]);
const searchKeys = new Set(["limit", "source", "namespace"]);
const secretDefaultsKeys = new Set(["env", "file", "exec"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cloneJson = <T>(value: T): T => structuredClone(value);

const parseLiteralValue = (raw: string): unknown => {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
    || (trimmed.startsWith("\"") && trimmed.endsWith("\""))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to a raw string.
    }
  }

  return raw;
};

const pathSegments = (path: string): string[] =>
  path.split(".").map((segment) => segment.trim()).filter((segment) => segment.length > 0);

const validateConfigPath = (segments: readonly string[]): string | null => {
  if (segments.length === 0) {
    return "Provide a non-empty config path.";
  }

  const [root, second, third] = segments;
  if (!root || !knownRoots.has(root)) {
    return `Unknown config root '${root ?? ""}'. Supported roots: ${Array.from(knownRoots).join(", ")}.`;
  }

  switch (root) {
    case "runtime":
      return segments.length === 1 ? null : "runtime is a top-level value.";
    case "workspace":
      return segments.length === 1 || (segments.length === 2 && second === "name")
        ? null
        : "workspace only supports the 'name' field in phase 1.";
    case "daemon":
      return segments.length === 1 || (segments.length === 2 && daemonKeys.has(second ?? ""))
        ? null
        : `daemon supports: ${Array.from(daemonKeys).join(", ")}.`;
    case "call":
      return segments.length === 1 || (segments.length === 2 && callKeys.has(second ?? ""))
        ? null
        : `call supports: ${Array.from(callKeys).join(", ")}.`;
    case "search":
      return segments.length === 1 || (segments.length === 2 && searchKeys.has(second ?? ""))
        ? null
        : `search supports: ${Array.from(searchKeys).join(", ")}.`;
    case "semanticSearch":
      return segments.length === 1 || (segments.length === 2 && semanticSearchKeys.has(second ?? ""))
        ? null
        : `semanticSearch supports: ${Array.from(semanticSearchKeys).join(", ")}.`;
    case "sources":
      return segments.length >= 2
        ? null
        : "sources requires a source key, for example 'sources.github'.";
    case "secrets":
      if (segments.length === 1) {
        return null;
      }
      if (second === "defaults") {
        return segments.length === 2 || (segments.length === 3 && secretDefaultsKeys.has(third ?? ""))
          ? null
          : `secrets.defaults supports: ${Array.from(secretDefaultsKeys).join(", ")}.`;
      }
      if (second === "providers") {
        return segments.length >= 3
          ? null
          : "secrets.providers requires a provider key, for example 'secrets.providers.env'.";
      }
      return "secrets supports 'defaults' and 'providers'.";
    default:
      return null;
  }
};

const getNestedValue = (value: unknown, segments: readonly string[]): unknown => {
  if (segments.length === 0) {
    return value;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  const [head, ...tail] = segments;
  if (!head || !(head in value)) {
    return undefined;
  }

  return getNestedValue(value[head], tail);
};

const setNestedValue = (
  value: LocalExecutorConfig,
  segments: readonly string[],
  nextValue: unknown,
): LocalExecutorConfig => {
  const clone = cloneJson(value);

  const apply = (target: Record<string, unknown>, rest: readonly string[]): void => {
    const [head, ...tail] = rest;
    if (!head) {
      return;
    }
    if (tail.length === 0) {
      target[head] = nextValue;
      return;
    }

    const current = target[head];
    if (current !== undefined && !isPlainObject(current)) {
      throw new Error(`Cannot set ${segments.join(".")} through non-object value at '${head}'.`);
    }

    const nextTarget = isPlainObject(current) ? current : {};
    target[head] = nextTarget;
    apply(nextTarget, tail);
  };

  apply(clone as Record<string, unknown>, segments);
  return clone;
};

const deleteNestedValue = (
  value: LocalExecutorConfig,
  segments: readonly string[],
): LocalExecutorConfig => {
  const clone = cloneJson(value);

  const prune = (target: Record<string, unknown>, rest: readonly string[]): boolean => {
    const [head, ...tail] = rest;
    if (!head || !(head in target)) {
      throw new Error(`Path '${segments.join(".")}' does not exist.`);
    }

    if (tail.length === 0) {
      delete target[head];
      return Object.keys(target).length === 0;
    }

    const current = target[head];
    if (!isPlainObject(current)) {
      throw new Error(`Cannot unset ${segments.join(".")} through non-object value at '${head}'.`);
    }

    const shouldRemoveCurrent = prune(current, tail);
    if (shouldRemoveCurrent) {
      delete target[head];
    }
    return Object.keys(target).length === 0;
  };

  prune(clone as Record<string, unknown>, segments);
  return clone;
};

const flattenEntries = (
  value: unknown,
  prefix: string[] = [],
): Array<{ path: string; value: unknown }> => {
  if (value === undefined) {
    return [];
  }

  if (!isPlainObject(value)) {
    return prefix.length === 0 ? [] : [{ path: prefix.join("."), value }];
  }

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return prefix.length === 0 ? [] : [{ path: prefix.join("."), value }];
  }

  const flattened: Array<{ path: string; value: unknown }> = [];
  for (const [key, child] of entries) {
    flattened.push(...flattenEntries(child, [...prefix, key]));
  }
  return flattened;
};

const renderValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
};

const formatScopeLabel = (scope: ConfigScope): string =>
  scope === "effective" ? "effective config" : `${scope} config`;

function resolveScope(
  flags: { global?: boolean; workspace?: boolean },
  defaultScope: "effective",
): ConfigScope;
function resolveScope(
  flags: { global?: boolean; workspace?: boolean },
  defaultScope: Exclude<ConfigScope, "effective">,
): Exclude<ConfigScope, "effective">;
function resolveScope(
  flags: { global?: boolean; workspace?: boolean },
  defaultScope: ConfigScope,
): ConfigScope {
  if (flags.global && flags.workspace) {
    throw new Error("Choose either --global or --workspace, not both.");
  }
  if (flags.global) {
    return "global";
  }
  if (flags.workspace) {
    return "workspace";
  }
  return defaultScope;
}

const loadWorkspaceConfigState = () =>
  Effect.gen(function* () {
    const context = yield* resolveLocalWorkspaceContext();
    const loaded = yield* loadLocalExecutorConfig(context);
    return { context, loaded };
  });

const getScopeConfig = (
  scope: ConfigScope,
  loaded: LoadedLocalExecutorConfig,
): LocalExecutorConfig | null => {
  switch (scope) {
    case "effective":
      return loaded.config ?? null;
    case "global":
      return loaded.homeConfig ?? null;
    case "workspace":
      return loaded.projectConfig ?? null;
  }
};

const normalizeConfig = (config: LocalExecutorConfig): LocalExecutorConfig =>
  mergeLocalExecutorConfigs(null, config) ?? config;

const readCurrentScopeConfig = (
  scope: Exclude<ConfigScope, "effective">,
  state: ConfigWorkspaceState,
): LocalExecutorConfig => {
  const current = getScopeConfig(scope, state.loaded);
  return current ?? {};
};

const writeScopeConfig = (input: {
  scope: Exclude<ConfigScope, "effective">;
  state: ConfigWorkspaceState;
  config: LocalExecutorConfig;
}) =>
  input.scope === "global"
    ? writeHomeLocalExecutorConfig({
        homeConfigPath: input.state.context.homeConfigPath,
        config: input.config,
      })
    : writeProjectLocalExecutorConfig({
        context: input.state.context,
        config: input.config,
      });

const getCommand = defineCommand({
  name: "get",
  description: "Read a config path",
  options: {
    ...scopeFlags,
    json: jsonFlag,
  },
  handler: async ({ flags, positional }) => {
    await runCliEffect(
      Effect.gen(function* () {
        const state = yield* loadWorkspaceConfigState();
        const scope = resolveScope(flags, "effective");
        const current = getScopeConfig(scope, state.loaded) ?? {};
        const path = positional[0];
        const value = path ? getNestedValue(current, pathSegments(path)) : current;

        if (value === undefined) {
          throw executorAppEffectError(
            "cli/config",
            path
              ? `Config path '${path}' not found in ${formatScopeLabel(scope)}.`
              : `No values found in ${formatScopeLabel(scope)}.`,
          );
        }

        if (flags.json || typeof value === "object") {
          yield* printJson(value);
          return;
        }

        yield* printText(renderValue(value));
      }),
    );
  },
});

const listCommand = defineCommand({
  name: "list",
  description: "List config entries",
  options: {
    ...scopeFlags,
    json: jsonFlag,
  },
  handler: async ({ flags }) => {
    await runCliEffect(
      Effect.gen(function* () {
        const state = yield* loadWorkspaceConfigState();
        const scope = resolveScope(flags, "effective");
        const current = getScopeConfig(scope, state.loaded) ?? {};
        const entries = flattenEntries(current).map((entry) => ({
          path: entry.path,
          value: entry.value,
        }));

        if (flags.json) {
          yield* printJson({
            scope,
            entries,
          });
          return;
        }

        if (entries.length === 0) {
          yield* printText(`No config entries found in ${formatScopeLabel(scope)}.`);
          return;
        }

        yield* printText(
          entries
            .map((entry) => `${entry.path} = ${renderValue(entry.value)}`)
            .join("\n"),
        );
      }),
    );
  },
});

const setCommand = defineCommand({
  name: "set",
  description: "Set a config path",
  options: {
    ...scopeFlags,
    json: jsonFlag,
  },
  handler: async ({ flags, positional }) => {
    await runCliEffect(
      Effect.gen(function* () {
        const path = positional[0];
        const rawValue = positional[1];

        if (!path || rawValue === undefined) {
          throw executorAppEffectError(
            "cli/config",
            "Usage: executor config set <path> <value> [--global|--workspace]",
          );
        }

        const segments = pathSegments(path);
        const pathError = validateConfigPath(segments);
        if (pathError) {
          throw executorAppEffectError("cli/config", pathError);
        }

        const state = yield* loadWorkspaceConfigState();
        const scope = resolveScope(flags, "workspace");
        const current = readCurrentScopeConfig(scope, state);
        const parsedValue = flags.json ? JSON.parse(rawValue) : parseLiteralValue(rawValue);
        const draft = setNestedValue(current, segments, parsedValue);
        const validated = normalizeConfig(draft);

        yield* writeScopeConfig({
          scope,
          state,
          config: validated,
        });

        if (flags.json) {
          yield* printJson({
            scope,
            path,
            value: parsedValue,
          });
          return;
        }

        yield* printText(`Set ${path} in ${formatScopeLabel(scope)}.`);
      }),
    );
  },
});

const unsetCommand = defineCommand({
  name: "unset",
  description: "Remove a config path",
  options: {
    ...scopeFlags,
    json: jsonFlag,
  },
  handler: async ({ flags, positional }) => {
    await runCliEffect(
      Effect.gen(function* () {
        const path = positional[0];
        if (!path) {
          throw executorAppEffectError(
            "cli/config",
            "Usage: executor config unset <path> [--global|--workspace]",
          );
        }

        const segments = pathSegments(path);
        const pathError = validateConfigPath(segments);
        if (pathError) {
          throw executorAppEffectError("cli/config", pathError);
        }

        const state = yield* loadWorkspaceConfigState();
        const scope = resolveScope(flags, "workspace");
        const current = readCurrentScopeConfig(scope, state);
        const draft = deleteNestedValue(current, segments);
        const validated = normalizeConfig(draft);

        yield* writeScopeConfig({
          scope,
          state,
          config: validated,
        });

        if (flags.json) {
          yield* printJson({
            scope,
            path,
            removed: true,
          });
          return;
        }

        yield* printText(`Unset ${path} in ${formatScopeLabel(scope)}.`);
      }),
    );
  },
});

const configGroup = defineGroup({
  name: "config",
  description: "Manage executor configuration",
  commands: [getCommand, setCommand, unsetCommand, listCommand],
});

export default configGroup;
