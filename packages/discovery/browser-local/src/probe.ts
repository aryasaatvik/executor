import type { ExecutorDescriptor, ExecutorTarget } from "@executor/api";

export interface ProbeOptions {
  readonly ports?: readonly number[];
  readonly timeout?: number;
}

const DEFAULT_PORTS = [46789] as const;
const DEFAULT_TIMEOUT = 2000;

const isExecutorDescriptor = (value: unknown): value is ExecutorDescriptor =>
  typeof value === "object"
  && value !== null
  && typeof (value as Record<string, unknown>).id === "string"
  && typeof (value as Record<string, unknown>).name === "string"
  && typeof (value as Record<string, unknown>).version === "string"
  && typeof (value as Record<string, unknown>).capabilities === "object"
  && (value as Record<string, unknown>).capabilities !== null;

const probeOrigin = async (
  origin: string,
  timeout: number,
): Promise<ExecutorTarget | null> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${origin}/discover`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timer);

    if (!response.ok) {
      return null;
    }

    const body: unknown = await response.json();

    if (!isExecutorDescriptor(body)) {
      return null;
    }

    return {
      kind: "local",
      origin,
      discoveredAt: Date.now(),
      managed: false,
    };
  } catch {
    return null;
  }
};

/**
 * Probe localhost ports for a running executor daemon.
 *
 * Calls `GET /discover` on each configured port and validates the response
 * against the ExecutorDescriptor shape. Returns the first successful target
 * or null if no daemon is found.
 */
export const probeLocalDaemon = async (
  opts?: ProbeOptions,
): Promise<ExecutorTarget | null> => {
  const ports = opts?.ports ?? DEFAULT_PORTS;
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;

  const results = await Promise.all(
    ports.map((port) => probeOrigin(`http://127.0.0.1:${port}`, timeout)),
  );

  return results.find((result): result is ExecutorTarget => result !== null) ?? null;
};
