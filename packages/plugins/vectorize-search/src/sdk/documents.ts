import type { Tool } from "@executor-js/sdk/core";

const ADDRESS_PREFIX = "tools.";

/** Strip the proxy-root `tools.` prefix so the address becomes the
 *  sandbox-callable path the model writes after `tools.` — mirrors the engine's
 *  own `addressToPath` so the `path` we index matches what `tools.search`
 *  callers expect (and can pass back to `describe`/invoke). */
const addressToPath = (address: string): string =>
  address.startsWith(ADDRESS_PREFIX) ? address.slice(ADDRESS_PREFIX.length) : address;

/** The indexed view of a tool: the `ToolDiscoveryResult` fields (returned at
 *  query time straight from Vectorize metadata) plus the text we embed. */
export interface ToolSearchDocument {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly integration: string;
  readonly embeddingText: string;
}

const joinText = (parts: readonly (string | undefined)[]): string =>
  parts
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n");

/** Vector id for a tool within a namespace. Vectorize ids are global, so the
 *  namespace is folded into the id to keep tenants' vectors distinct. */
export const toolVectorId = (namespace: string, path: string): string => `${namespace}#${path}`;

export const projectToolDocument = (namespace: string, tool: Tool): ToolSearchDocument => {
  const path = addressToPath(String(tool.address));
  const name = String(tool.name);
  const description = tool.description;
  const integration = String(tool.integration);
  return {
    id: toolVectorId(namespace, path),
    path,
    name,
    description,
    integration,
    embeddingText: joinText([`${integration} ${path}`, name, description]),
  };
};
