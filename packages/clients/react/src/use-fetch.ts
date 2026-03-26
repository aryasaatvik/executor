import * as React from "react";
import type { Loadable } from "./types";

export class FetchError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`Request failed with status ${status}`);
    this.name = "FetchError";
    this.status = status;
    this.body = body;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    throw new FetchError(response.status, body);
  }
  return response.json() as Promise<T>;
}

export { fetchJson };

export function useFetch<T>(
  url: string | null,
  version: number,
): Loadable<T> {
  const [state, setState] = React.useState<Loadable<T>>({ status: "loading" });

  React.useEffect(() => {
    if (url === null) {
      setState({ status: "loading" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    fetchJson<T>(url)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            status: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url, version]);

  return state;
}
