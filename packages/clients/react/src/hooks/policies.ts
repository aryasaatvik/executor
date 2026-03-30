import {
  useAtomRefresh,
  useAtomSet,
} from "@effect-atom/atom-react";
import type {
  LocalScopePolicy,
} from "@executor/platform-sdk/schema";
import type {
  CreatePolicyPayload,
  UpdatePolicyPayload,
} from "@executor/platform-api";
import * as React from "react";

import { policiesAtom } from "../core/api-atoms";
import { disabledAtom, useLoadableAtom } from "../core/loadable";
import { policiesReactivityKey } from "../core/reactivity";
import type { Loadable } from "../core/types";
import { pendingLoadable, useWorkspaceRequestContext } from "../core/workspace";
import { getExecutorApiHttpClient } from "../core/http-client";
import { useExecutorMutation } from "./mutations";

export const usePolicies = (): Loadable<ReadonlyArray<LocalScopePolicy>> => {
  const workspace = useWorkspaceRequestContext();
  const atom = workspace.enabled
    ? policiesAtom(workspace.workspaceId)
    : disabledAtom<ReadonlyArray<LocalScopePolicy>>();
  const policies = useLoadableAtom(atom);

  return workspace.enabled ? policies : pendingLoadable(workspace.workspace);
};

export const useRefreshPolicies = (): (() => void) => {
  const workspace = useWorkspaceRequestContext();
  const refresh = useAtomRefresh(
    workspace.enabled
      ? policiesAtom(workspace.workspaceId)
      : disabledAtom<ReadonlyArray<LocalScopePolicy>>(),
  );

  return refresh;
};

export const useCreatePolicy = () => {
  const workspace = useWorkspaceRequestContext();
  const mutate = useAtomSet(
    getExecutorApiHttpClient().mutation("policies", "create"),
    { mode: "promise" },
  );

  return useExecutorMutation<CreatePolicyPayload, LocalScopePolicy>(
    React.useCallback(
      (payload) => {
        if (!workspace.enabled) {
          return Promise.reject(
            new Error("Executor workspace context is not ready"),
          );
        }

        return mutate({
          path: {
            workspaceId: workspace.workspaceId,
          },
          payload,
          reactivityKeys: policiesReactivityKey(workspace.workspaceId),
        });
      },
      [mutate, workspace.enabled, workspace.workspaceId],
    ),
  );
};

export const useUpdatePolicy = () => {
  const workspace = useWorkspaceRequestContext();
  const mutate = useAtomSet(
    getExecutorApiHttpClient().mutation("policies", "update"),
    { mode: "promise" },
  );

  return useExecutorMutation<
    { policyId: LocalScopePolicy["id"]; payload: UpdatePolicyPayload },
    LocalScopePolicy
  >(
    React.useCallback(
      (input) => {
        if (!workspace.enabled) {
          return Promise.reject(
            new Error("Executor workspace context is not ready"),
          );
        }

        return mutate({
          path: {
            workspaceId: workspace.workspaceId,
            policyId: input.policyId,
          },
          payload: input.payload,
          reactivityKeys: policiesReactivityKey(workspace.workspaceId),
        });
      },
      [mutate, workspace.enabled, workspace.workspaceId],
    ),
  );
};

export const useRemovePolicy = () => {
  const workspace = useWorkspaceRequestContext();
  const mutate = useAtomSet(
    getExecutorApiHttpClient().mutation("policies", "remove"),
    { mode: "promise" },
  );

  return useExecutorMutation<
    LocalScopePolicy["id"],
    { removed: boolean }
  >(
    React.useCallback(
      (policyId) => {
        if (!workspace.enabled) {
          return Promise.reject(
            new Error("Executor workspace context is not ready"),
          );
        }

        return mutate({
          path: {
            workspaceId: workspace.workspaceId,
            policyId,
          },
          reactivityKeys: policiesReactivityKey(workspace.workspaceId),
        });
      },
      [mutate, workspace.enabled, workspace.workspaceId],
    ),
  );
};
