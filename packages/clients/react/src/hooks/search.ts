import {
  useAtomSet,
} from "@effect-atom/atom-react";
import type {
  SearchProviderStatus,
} from "@executor/platform-api";
import * as React from "react";

import { getExecutorApiHttpClient } from "../core/http-client";
import {
  searchProviderStatusAtom,
} from "../core/api-atoms";
import { disabledAtom, useLoadableAtom } from "../core/loadable";
import { searchProviderStatusReactivityKey } from "../core/reactivity";
import type { Loadable } from "../core/types";
import { pendingLoadable, useWorkspaceRequestContext } from "../core/workspace";
import { useExecutorMutation } from "./mutations";

export const useSearchProviderStatus = (): Loadable<SearchProviderStatus> => {
  const workspace = useWorkspaceRequestContext();
  const atom = workspace.enabled
    ? searchProviderStatusAtom(workspace.workspaceId)
    : disabledAtom<SearchProviderStatus>();
  const status = useLoadableAtom(atom);

  return workspace.enabled ? status : pendingLoadable(workspace.workspace);
};

export const useRefreshSearchProvider = () => {
  const workspace = useWorkspaceRequestContext();
  const mutate = useAtomSet(
    getExecutorApiHttpClient().mutation("search", "refresh"),
    { mode: "promise" },
  );

  return useExecutorMutation<undefined, SearchProviderStatus>(
    React.useCallback(
      (_input: undefined) => {
        if (!workspace.enabled) {
          return Promise.reject(
            new Error("Executor workspace context is not ready"),
          );
        }

        return mutate({
          path: {
            workspaceId: workspace.workspaceId,
          },
          reactivityKeys: searchProviderStatusReactivityKey(
            workspace.workspaceId,
          ),
        });
      },
      [mutate, workspace.enabled, workspace.workspaceId],
    ),
  );
};

export const useRebuildSearchProvider = () => {
  const workspace = useWorkspaceRequestContext();
  const mutate = useAtomSet(
    getExecutorApiHttpClient().mutation("search", "rebuild"),
    { mode: "promise" },
  );

  return useExecutorMutation<undefined, SearchProviderStatus>(
    React.useCallback(
      (_input: undefined) => {
        if (!workspace.enabled) {
          return Promise.reject(
            new Error("Executor workspace context is not ready"),
          );
        }

        return mutate({
          path: {
            workspaceId: workspace.workspaceId,
          },
          reactivityKeys: searchProviderStatusReactivityKey(
            workspace.workspaceId,
          ),
        });
      },
      [mutate, workspace.enabled, workspace.workspaceId],
    ),
  );
};
