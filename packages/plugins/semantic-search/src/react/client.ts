import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";

import { SemanticSearchGroup } from "../api/group";

// Typed reactive client for the semantic-search plugin's HTTP surface
// (search / status / reindex). Mirrors execution-history's `ExecutionHistoryClient`:
// it binds to the active Executor Server Connection's base URL + auth header so
// the page works against whichever host the console is pointed at.
export const SemanticSearchClient = createPluginAtomClient(SemanticSearchGroup, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});
