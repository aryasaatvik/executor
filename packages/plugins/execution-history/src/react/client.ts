import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";

import { ExecutionHistoryGroup } from "../api/group";

export const ExecutionHistoryClient = createPluginAtomClient(ExecutionHistoryGroup, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});
