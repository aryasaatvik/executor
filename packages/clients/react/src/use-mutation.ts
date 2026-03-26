import * as React from "react";
import type { MutationResult } from "./types";

export function useMutation<TInput, TOutput>(
  execute: (payload: TInput) => Promise<TOutput>,
  options?: { onSuccess?: () => void },
): MutationResult<TInput, TOutput> {
  const [state, setState] = React.useState<{
    status: "idle" | "pending" | "success" | "error";
    data: TOutput | null;
    error: Error | null;
  }>({ status: "idle", data: null, error: null });

  const mutateAsync = React.useCallback(
    async (payload: TInput) => {
      setState((prev) => ({ status: "pending", data: prev.data, error: null }));
      try {
        const data = await execute(payload);
        setState({ status: "success", data, error: null });
        options?.onSuccess?.();
        return data;
      } catch (cause) {
        const error =
          cause instanceof Error ? cause : new Error(String(cause));
        setState({ status: "error", data: null, error });
        throw error;
      }
    },
    [execute, options],
  );

  const reset = React.useCallback(() => {
    setState({ status: "idle", data: null, error: null });
  }, []);

  return React.useMemo(
    () => ({ ...state, mutateAsync, reset }),
    [state, mutateAsync, reset],
  );
}
