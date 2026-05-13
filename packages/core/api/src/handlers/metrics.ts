import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ExecutorApi } from "../api";
import { renderPrometheus } from "../metrics/prometheus";

export const MetricsHandlers = HttpApiBuilder.group(ExecutorApi, "metrics", (handlers) =>
  handlers.handle("scrape", () => renderPrometheus),
);
