import * as Metrics from "@effect/opentelemetry/Metrics";
import * as Resource from "@effect/opentelemetry/Resource";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { Effect, Layer, ManagedRuntime } from "effect";

const SERVICE_NAME = "executor-local";
const SERVICE_VERSION = "1.0.0";

const parseHeaders = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    const key = entry.slice(0, separator).trim();
    if (!key) continue;
    headers[key] = entry.slice(separator + 1).trim();
  }
  return headers;
};

const makeMetricsLive = (): Layer.Layer<never> => {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (!endpoint) return Layer.empty;

  return Metrics.layer(
    () =>
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: endpoint,
          headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS),
        }),
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 10_000),
      }),
    { temporality: "cumulative" },
  ).pipe(
    Layer.provide(Resource.layer({ serviceName: SERVICE_NAME, serviceVersion: SERVICE_VERSION })),
  );
};

const metricsRuntime = ManagedRuntime.make(makeMetricsLive());

export const startMetricsExport = (): Effect.Effect<void> =>
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    ? Effect.promise(() => metricsRuntime.runPromise(Effect.void))
    : Effect.void;
