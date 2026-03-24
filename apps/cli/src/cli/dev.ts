import type { ExecutorEffectApi } from "@executor/client";
import * as Effect from "effect/Effect";

const readBindingString = (binding: Record<string, unknown>, key: string): string | null =>
  typeof binding[key] === "string" ? String(binding[key]) : null;

type SeedDemoMcpSourceInput = {
  api: ExecutorEffectApi["sources"];
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
  api: ExecutorEffectApi["sources"];
  endpoint: string;
  specUrl: string;
  name: string;
  namespace: string;
  credentialEnvVar?: string;
};

export const seedDemoMcpSourceInWorkspace = (
  input: SeedDemoMcpSourceInput,
): Effect.Effect<SeedDemoMcpSourceResult, unknown, never> =>
  Effect.gen(function* () {
    const existing = yield* input.api.list();

    const existingByName = existing.find(
      (source) => source.kind === "mcp" && source.name === input.name,
    );

    const expected = {
      endpoint: input.endpoint,
      namespace: input.namespace,
      transport: "streamable-http" as const,
    };

    if (
      existingByName !== undefined
      && existingByName.endpoint === expected.endpoint
      && existingByName.namespace === expected.namespace
      && readBindingString(existingByName.binding, "transport") === expected.transport
      && existingByName.auth.kind === "none"
    ) {
      return {
        action: "noop",
        sourceId: existingByName.id,
        endpoint: existingByName.endpoint,
      };
    }

    if (existingByName !== undefined) {
      const updated = yield* input.api.update(existingByName.id, {
        endpoint: input.endpoint,
        status: "connected",
        enabled: true,
        namespace: input.namespace,
        binding: {
          transport: "streamable-http",
          queryParams: null,
          headers: null,
        },
        auth: {
          kind: "none",
        },
      });

      return {
        action: "updated",
        sourceId: updated.id,
        endpoint: updated.endpoint,
      };
    }

    const created = yield* input.api.create({
      name: input.name,
      kind: "mcp",
      endpoint: input.endpoint,
      status: "connected",
      enabled: true,
      namespace: input.namespace,
      binding: {
        transport: "streamable-http",
        queryParams: null,
        headers: null,
      },
      auth: {
        kind: "none",
      },
    });

    return {
      action: "created",
      sourceId: created.id,
      endpoint: created.endpoint,
    };
  });

export const seedGithubOpenApiSourceInWorkspace = (
  input: SeedGithubOpenApiSourceInput,
): Effect.Effect<SeedDemoMcpSourceResult, unknown, never> =>
  Effect.gen(function* () {
    const existing = yield* input.api.list();

    const existingByName = existing.find(
      (source) => source.kind === "openapi" && source.name === input.name,
    );

    const auth = {
      kind: "bearer" as const,
      headerName: "Authorization",
      prefix: "Bearer ",
      token: {
        providerId: "env",
        handle: input.credentialEnvVar ?? "GITHUB_TOKEN",
      },
    };

    if (
      existingByName !== undefined
      && existingByName.endpoint === input.endpoint
      && existingByName.namespace === input.namespace
      && readBindingString(existingByName.binding, "specUrl") === input.specUrl
      && JSON.stringify(existingByName.binding.defaultHeaders ?? null) === JSON.stringify(null)
      && JSON.stringify(existingByName.auth) === JSON.stringify(auth)
    ) {
      return {
        action: "noop",
        sourceId: existingByName.id,
        endpoint: existingByName.endpoint,
      };
    }

    if (existingByName !== undefined) {
      const updated = yield* input.api.update(existingByName.id, {
        endpoint: input.endpoint,
        status: "connected",
        enabled: true,
        namespace: input.namespace,
        binding: {
          specUrl: input.specUrl,
          defaultHeaders: null,
        },
        auth,
      });

      return {
        action: "updated",
        sourceId: updated.id,
        endpoint: updated.endpoint,
      };
    }

    const created = yield* input.api.create({
      name: input.name,
      kind: "openapi",
      endpoint: input.endpoint,
      status: "connected",
      enabled: true,
      namespace: input.namespace,
      binding: {
        specUrl: input.specUrl,
        defaultHeaders: null,
      },
      auth,
    });

    return {
      action: "created",
      sourceId: created.id,
      endpoint: created.endpoint,
    };
  });
