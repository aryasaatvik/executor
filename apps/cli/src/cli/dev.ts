import type { Executor } from "@executor/client";
import * as Effect from "effect/Effect";

const toError = (cause: unknown) =>
  cause instanceof Error ? cause : new Error(String(cause));

const readBindingString = (binding: Record<string, unknown>, key: string): string | null =>
  typeof binding[key] === "string" ? String(binding[key]) : null;

type SeedDemoMcpSourceInput = {
  api: Executor["sources"];
  endpoint: string;
  name: string;
  namespace: string;
};

type SeedDemoMcpSourceResult =
  | {
      action: "noop";
      sourceId: string;
      endpoint: string;
    }
  | {
      action: "updated" | "created";
      sourceId: string;
      endpoint: string;
    };

type SeedGithubOpenApiSourceInput = {
  api: Executor["sources"];
  endpoint: string;
  specUrl: string;
  name: string;
  namespace: string;
  credentialEnvVar?: string;
};

export const seedDemoMcpSourceInWorkspace = (
  input: SeedDemoMcpSourceInput,
): Effect.Effect<SeedDemoMcpSourceResult, Error> =>
  Effect.gen(function* () {
    const existing = yield* Effect.tryPromise({
      try: () => input.api.list(),
      catch: toError,
    });

    const existingByName = (existing as any[]).find(
      (source: any) => source.kind === "mcp" && source.name === input.name,
    );

    const expected = {
      endpoint: input.endpoint,
      namespace: input.namespace,
      transport: "streamable-http" as const,
    };

    if (existingByName) {
      const binding = existingByName.binding ?? {};
      if (
        readBindingString(binding, "endpoint") === expected.endpoint
        && readBindingString(binding, "namespace") === expected.namespace
      ) {
        return {
          action: "noop" as const,
          sourceId: existingByName.id,
          endpoint: input.endpoint,
        };
      }

      yield* Effect.tryPromise({
        try: () => input.api.update(existingByName.id, {
          binding: expected,
        }),
        catch: toError,
      });

      return {
        action: "updated" as const,
        sourceId: existingByName.id,
        endpoint: input.endpoint,
      };
    }

    const created = yield* Effect.tryPromise({
      try: () => input.api.create({
        kind: "mcp",
        name: input.name,
        binding: expected,
      }),
      catch: toError,
    });

    return {
      action: "created" as const,
      sourceId: (created as any).id,
      endpoint: input.endpoint,
    };
  });

export const seedGithubOpenApiSourceInWorkspace = (
  input: SeedGithubOpenApiSourceInput,
): Effect.Effect<SeedDemoMcpSourceResult, Error> =>
  Effect.gen(function* () {
    const existing = yield* Effect.tryPromise({
      try: () => input.api.list(),
      catch: toError,
    });

    const existingByName = (existing as any[]).find(
      (source: any) => source.kind === "openapi" && source.name === input.name,
    );

    const expected = {
      endpoint: input.endpoint,
      specUrl: input.specUrl,
      namespace: input.namespace,
    };

    if (existingByName) {
      const binding = existingByName.binding ?? {};
      if (
        readBindingString(binding, "endpoint") === expected.endpoint
        && readBindingString(binding, "specUrl") === expected.specUrl
      ) {
        return {
          action: "noop" as const,
          sourceId: existingByName.id,
          endpoint: input.endpoint,
        };
      }

      yield* Effect.tryPromise({
        try: () => input.api.update(existingByName.id, {
          binding: expected,
        }),
        catch: toError,
      });

      return {
        action: "updated" as const,
        sourceId: existingByName.id,
        endpoint: input.endpoint,
      };
    }

    const created = yield* Effect.tryPromise({
      try: () => input.api.create({
        kind: "openapi",
        name: input.name,
        binding: expected,
      }),
      catch: toError,
    });

    return {
      action: "created" as const,
      sourceId: (created as any).id,
      endpoint: input.endpoint,
    };
  });
