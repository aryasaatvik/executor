import * as React from "react";

const DEFAULT_BASE_URL = "http://127.0.0.1:8788";

export interface ExecutorContextValue {
  readonly baseUrl: string;
  readonly invalidationVersion: number;
  readonly invalidateQueries: () => void;
}

const ExecutorContext = React.createContext<ExecutorContextValue | null>(null);

export function useExecutorContext(): ExecutorContextValue {
  const ctx = React.useContext(ExecutorContext);
  if (ctx === null) {
    throw new Error("ExecutorReactProvider is missing from the React tree");
  }
  return ctx;
}

export function ExecutorReactProvider(
  props: React.PropsWithChildren<{ baseUrl?: string }>,
) {
  const baseUrl = props.baseUrl ?? DEFAULT_BASE_URL;
  const [invalidationVersion, bump] = React.useReducer(
    (n: number) => n + 1,
    0,
  );
  const invalidateQueries = React.useCallback(() => bump(), []);

  const value = React.useMemo<ExecutorContextValue>(
    () => ({ baseUrl, invalidationVersion, invalidateQueries }),
    [baseUrl, invalidationVersion, invalidateQueries],
  );

  return (
    <ExecutorContext.Provider value={value}>
      {props.children}
    </ExecutorContext.Provider>
  );
}
