import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

import { InternalError } from "../observability";

const PrometheusResponse = Schema.String.pipe(HttpApiSchema.asText());

export const MetricsApi = HttpApiGroup.make("metrics").add(
  HttpApiEndpoint.get("scrape", "/metrics", {
    success: PrometheusResponse,
    error: InternalError,
  }),
);
