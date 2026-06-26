import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ToolDiscoveryProvider, ToolDiscoveryResult } from "@executor-js/sdk/core";

import { SemanticSearchError } from "./errors";
import { makeSemanticSearchExtension } from "./plugin";

// A result whose integration/path is NOT the tenant id. This is exactly the case
// the bug broke: the operator search defaulted the integration-prefix filter to
// the tenant namespace ("default"), and the provider's `matchesNamespace` then
// dropped every tool whose path didn't start with "default" — i.e. all of them.
const githubItem: ToolDiscoveryResult = {
  path: "github_api.repos.get",
  name: "repos.get",
  description: "Get a repository",
  integration: "github_api",
  score: 0.9,
};

// Build the extension with only what `search` needs: a tenant namespace and a
// provider that records the prefix it is handed. The remaining deps are unused
// by `search` (they drive indexing), so they stay undefined.
const extensionWith = (provider: ToolDiscoveryProvider) =>
  makeSemanticSearchExtension({
    backend: {
      namespace: "default", // tenant id — NOT a tool prefix
      provider,
      index: () => undefined as never,
      reindex: () => Effect.die("unused"),
      sweep: () => Effect.die("unused"),
      search: (executor, input) =>
        provider
          .searchTools({
            executor,
            query: input.query,
            namespace: input.namespace,
            limit: input.limit ?? 20,
            offset: 0,
          })
          .pipe(
            Effect.map((page) => ({
              namespace: "default",
              query: input.query,
              items: page.items,
            })),
            Effect.mapError(
              (cause) => new SemanticSearchError({ message: "Test provider failed.", cause }),
            ),
          ),
      status: () => Effect.die("unused"),
    },
  });

describe("makeSemanticSearchExtension — search namespace handling", () => {
  it.effect("does not default the integration prefix to the tenant namespace", () =>
    Effect.gen(function* () {
      let calls = 0;
      let receivedPrefix: string | undefined;
      const ext = extensionWith({
        searchTools: (input) => {
          calls += 1;
          receivedPrefix = input.namespace;
          return Effect.succeed({
            items: [githubItem],
            total: 1,
            hasMore: false,
            nextOffset: null,
          });
        },
      });

      const page = yield* ext.search(undefined as never, { query: "github" });

      // Regression: with no operator prefix, the provider must receive `undefined`
      // (no filter) — NOT the tenant namespace, which would drop every result.
      expect(calls).toBe(1);
      expect(receivedPrefix).toBeUndefined();
      // The tenant-tagged result survives, and the page reports the tenant.
      expect(page.items).toEqual([githubItem]);
      expect(page.namespace).toBe("default");
    }),
  );

  it.effect("passes an explicit integration prefix through to the provider", () =>
    Effect.gen(function* () {
      let receivedPrefix: string | undefined;
      const ext = extensionWith({
        searchTools: (input) => {
          receivedPrefix = input.namespace;
          return Effect.succeed({ items: [], total: 0, hasMore: false, nextOffset: null });
        },
      });

      yield* ext.search(undefined as never, { query: "x", namespace: "github_api" });

      expect(receivedPrefix).toBe("github_api");
    }),
  );
});
