import { describe, expect, it } from "@effect/vitest";

import { ACTOR_PALETTE, actorTone } from "./status";

const MUTED = {
  dot: "bg-muted-foreground/40",
  text: "text-muted-foreground",
} as const;

describe("actorTone", () => {
  it("mutes a missing actor id", () => {
    expect(actorTone(null)).toEqual(MUTED);
    expect(actorTone(undefined)).toEqual(MUTED);
  });

  it("returns the same palette slot for the same id", () => {
    expect(actorTone("tok.phoenix")).toEqual(actorTone("tok.phoenix"));
  });

  it("picks a palette entry, not the muted fallback, for a real id", () => {
    const tone = actorTone("tok.phoenix");
    expect(ACTOR_PALETTE).toContainEqual(tone);
  });

  it("spreads distinct ids across more than one hue", () => {
    const ids = ["phoenix", "agni", "blaze", "cursor", "527888ce-060c-5"];
    const uniqueDots = new Set(ids.map((id) => actorTone(id).dot));
    expect(uniqueDots.size).toBeGreaterThan(1);
  });
});
