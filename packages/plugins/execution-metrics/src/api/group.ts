import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Responses
//
// The scrape endpoint returns Prometheus text-exposition, not JSON.
// `HttpApiSchema.asText()` flips the success body to `text/plain` so the
// renderer's string is written verbatim.
// ---------------------------------------------------------------------------

const PrometheusResponse = Schema.String.pipe(HttpApiSchema.asText());

// ---------------------------------------------------------------------------
// Group — the execution-metrics HTTP surface.
//
// One GET endpoint. Auth-gated automatically by the host's execution-stack
// middleware, like every other plugin route. `InternalError` is the shared
// opaque 500 surface translated at the HTTP edge by `capture`.
// ---------------------------------------------------------------------------

export const ExecutionMetricsGroup = HttpApiGroup.make("execution-metrics").add(
  HttpApiEndpoint.get("metrics", "/execution-metrics/metrics", {
    success: PrometheusResponse,
    error: InternalError,
  }),
);
