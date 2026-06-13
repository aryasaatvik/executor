import { Effect, Match, Metric } from "effect";

// ---------------------------------------------------------------------------
// Prometheus text-exposition renderer.
//
// Snapshots the global Effect Metric registry (`Metric.snapshot`) and renders
// the v0.0.4 text format: one HELP/TYPE header pair per metric name, then a
// sample line per attribute-set. Histograms expand to cumulative `_bucket`
// series (with a terminal `le="+Inf"`), `_count`, and `_sum`.
// ---------------------------------------------------------------------------

const sanitizeName = (raw: string): string => raw.replace(/[^a-zA-Z0-9_:]/g, "_");

const escapeLabelValue = (raw: string): string =>
  raw.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

const formatValue = (value: bigint | number): string => {
  if (typeof value === "bigint") return value.toString(10);
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
};

const formatLabels = (
  attributes: Metric.Metric.AttributeSet,
  extra?: Readonly<Record<string, string>>,
): string => {
  const pairs = Object.entries(attributes).map(
    ([key, value]) => `${sanitizeName(key)}="${escapeLabelValue(String(value))}"`,
  );
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      pairs.push(`${sanitizeName(key)}="${escapeLabelValue(value)}"`);
    }
  }
  return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
};

const emitHeader = (
  name: string,
  type: "counter" | "gauge" | "histogram" | "summary",
  description: string,
  seen: Set<string>,
): readonly string[] => {
  if (seen.has(name)) return [];
  seen.add(name);
  const safeDescription = description.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
  return [`# HELP ${name} ${safeDescription || "(no description)"}`, `# TYPE ${name} ${type}`];
};

const formatPair = (metric: Metric.Metric.Snapshot, seen: Set<string>): readonly string[] => {
  const name = sanitizeName(metric.id);
  const description = metric.description ?? "";
  const attributes = metric.attributes ?? {};
  return Match.value(metric).pipe(
    Match.when({ type: "Counter" }, (metric) => {
      const state = metric.state;
      return [
        ...emitHeader(name, "counter", description, seen),
        `${name}${formatLabels(attributes)} ${formatValue(state.count)}`,
      ];
    }),
    Match.when({ type: "Gauge" }, (metric) => {
      const state = metric.state;
      return [
        ...emitHeader(name, "gauge", description, seen),
        `${name}${formatLabels(attributes)} ${formatValue(state.value)}`,
      ];
    }),
    Match.when({ type: "Histogram" }, (metric) => {
      const state = metric.state;
      const lines = [...emitHeader(name, "histogram", description, seen)];
      // Effect's HistogramState.buckets already ends with the terminal
      // `Infinity` boundary (formatted as `le="+Inf"`), whose cumulative count
      // equals the total observation count. Emitting it from the loop covers
      // Prometheus's required `+Inf` bucket — appending a second `+Inf` line
      // would duplicate the series and the scrape would be rejected.
      for (const [upperBound, count] of state.buckets) {
        lines.push(
          `${name}_bucket${formatLabels(attributes, { le: formatValue(upperBound) })} ${count}`,
        );
      }
      lines.push(`${name}_count${formatLabels(attributes)} ${state.count}`);
      lines.push(`${name}_sum${formatLabels(attributes)} ${formatValue(state.sum)}`);
      return lines;
    }),
    Match.when({ type: "Summary" }, (metric) => {
      const state = metric.state;
      const lines = [...emitHeader(name, "summary", description, seen)];
      for (const [quantile, value] of state.quantiles) {
        lines.push(
          `${name}${formatLabels(attributes, { quantile: formatValue(quantile) })} ${formatValue(
            value ?? Number.NaN,
          )}`,
        );
      }
      lines.push(`${name}_count${formatLabels(attributes)} ${state.count}`);
      lines.push(`${name}_sum${formatLabels(attributes)} ${formatValue(state.sum)}`);
      return lines;
    }),
    Match.when({ type: "Frequency" }, (metric) => {
      const state = metric.state;
      const lines = [...emitHeader(name, "counter", description, seen)];
      for (const [bucket, count] of state.occurrences) {
        lines.push(`${name}${formatLabels(attributes, { bucket })} ${formatValue(count)}`);
      }
      return lines;
    }),
    Match.exhaustive,
  );
};

/** Snapshot the global Effect Metric registry and render Prometheus text. */
export const renderPrometheus: Effect.Effect<string> = Effect.map(Metric.snapshot, (snapshot) => {
  const seen = new Set<string>();
  const lines = snapshot.flatMap((pair) => formatPair(pair, seen));
  return lines.length === 0 ? "\n" : `${lines.join("\n")}\n`;
});
