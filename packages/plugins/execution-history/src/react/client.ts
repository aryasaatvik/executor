import { createPluginAtomClient } from "@executor-js/sdk/client";
import { getBaseUrl } from "@executor-js/react/api/base-url";

import { ExecutionHistoryGroup } from "../api/group";

export const ExecutionHistoryClient = createPluginAtomClient(ExecutionHistoryGroup, {
  baseUrl: getBaseUrl,
});
