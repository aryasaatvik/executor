import { describe, expect, it } from "@effect/vitest";
import { Effect, Metric } from "effect";

import { renderPrometheus } from "./prometheus";

const uniqueName = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

describe("renderPrometheus", () => {
  it.effect("emits counter HELP + TYPE + sanitized name", () =>
    Effect.gen(function* () {
      const name = uniqueName("pr_counter.ticks");
      const counter = Metric.counter(name, {
        description: "example counter",
        incremental: true,
      });
      yield* Metric.update(counter, 7);

      const output = yield* renderPrometheus;
      const sanitized = name.replace(/\./g, "_");
      expect(output).toMatch(new RegExp(`# HELP ${sanitized} example counter`));
      expect(output).toMatch(new RegExp(`# TYPE ${sanitized} counter`));
      expect(output).toMatch(new RegExp(`^${sanitized} 7$`, "m"));
    }),
  );

  it.effect("emits histogram bucket lines + +Inf + count + sum", () =>
    Effect.gen(function* () {
      const name = uniqueName("pr_hist.ms");
      const histogram = Metric.histogram(name, {
        boundaries: Metric.linearBoundaries({ start: 0, width: 10, count: 3 }),
      });
      yield* Metric.update(histogram, 5);
      yield* Metric.update(histogram, 15);

      const output = yield* renderPrometheus;
      const sanitized = name.replace(/\./g, "_");
      expect(output).toMatch(new RegExp(`# TYPE ${sanitized} histogram`));
      expect(output).toMatch(new RegExp(`^${sanitized}_bucket{le="\\+Inf"} 2$`, "m"));
      expect(output).toMatch(new RegExp(`^${sanitized}_count 2$`, "m"));
      expect(output).toMatch(new RegExp(`^${sanitized}_sum 20$`, "m"));
    }),
  );

  it.effect("escapes label values with quotes + backslashes", () =>
    Effect.gen(function* () {
      const name = uniqueName("pr_labeled");
      const counter = Metric.withAttributes(Metric.counter(name, { incremental: true }), {
        path: `github.io/search"broken\\"`,
      });
      yield* Metric.update(counter, 1);

      const output = yield* renderPrometheus;
      expect(output).toContain(`${name}{path="github.io/search\\"broken\\\\\\""} 1`);
    }),
  );
});
