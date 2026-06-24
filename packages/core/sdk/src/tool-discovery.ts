import { Data, type Effect } from "effect";

import type { Executor } from "./executor";
import type { AnyPlugin, PluginExtensions } from "./plugin";

/* The tool-discovery contract: the backend behind the sandbox `tools.search`
 * call. The engine holds a single provider. Plugins opt in via
 * `plugin.runtime.toolDiscoveryProvider` (mirroring `executionObserver`) to
 * supply a custom one, for example semantic search backed by a host service. When no
 * plugin provides one the engine keeps its built-in lexical scorer.
 *
 * This contract lives in `sdk` (not `execution`) so the plugin spec can name it
 * without a `sdk -> execution` cycle; `@executor-js/execution` re-exports it. */

/** Raised when a discovery provider fails to search. */
export class ExecutionToolError extends Data.TaggedError("ExecutionToolError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** One match returned by `tools.search`. */
export type ToolDiscoveryResult = {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly integration: string;
  readonly score: number;
};

export type ToolDiscoveryInput = {
  readonly executor: Executor;
  readonly query: string;
  readonly namespace?: string;
  readonly limit: number;
  readonly offset: number;
};

/**
 * Page of results from a list-style discovery tool. Shared by `tools.search`
 * and `tools.executor.sources.list` so the model sees one consistent shape:
 *
 *   - `items`      - the page (slice).
 *   - `total`      - count after filtering, before pagination. The model can
 *                    use this to detect truncation.
 *   - `hasMore`    - convenience flag for `(offset + items.length) < total`.
 *   - `nextOffset` - concrete offset for the next page when `hasMore`, `null`
 *                    otherwise. Pre-computing it removes a class of off-by-one
 *                    mistakes when the model paginates.
 */
export type PagedResult<T> = {
  readonly items: readonly T[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
};

export interface ToolDiscoveryProvider {
  readonly searchTools: (
    input: ToolDiscoveryInput,
  ) => Effect.Effect<PagedResult<ToolDiscoveryResult>, ExecutionToolError>;
}

/**
 * Pick the tool-discovery provider a plugin contributes via
 * `runtime.toolDiscoveryProvider`, bound to that plugin's extension. Returns
 * the FIRST plugin (in registration order) that supplies one, or `undefined`
 * when none do - in which case the engine keeps its built-in lexical scorer.
 *
 * Unlike observers, search is singular: one provider answers `tools.search`, so
 * providers do not compose/fan out. Registration order is the tiebreak; a host
 * that wants the semantic provider to win simply registers it before any other
 * search-providing plugin.
 */
export const composeToolDiscoveryProviders = <TPlugins extends readonly AnyPlugin[]>(
  plugins: TPlugins,
  extensions: PluginExtensions<TPlugins>,
): ToolDiscoveryProvider | undefined => {
  for (const plugin of plugins) {
    const provider = plugin.runtime?.toolDiscoveryProvider?.(
      extensions[plugin.id as keyof PluginExtensions<TPlugins>] as never,
    );
    if (provider) {
      return provider;
    }
  }
  return undefined;
};
