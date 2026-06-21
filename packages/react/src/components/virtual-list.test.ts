import { describe, expect, it } from "@effect/vitest";

import {
  clearScrollPosition,
  DEFAULT_END_REACHED_THRESHOLD,
  isNearBottom,
  readScrollPosition,
  resolveActiveStickyIndex,
  saveScrollPosition,
} from "./virtual-list";

describe("isNearBottom", () => {
  it("is true exactly at the threshold and false just above it", () => {
    // distanceFromBottom = scrollHeight - scrollTop - clientHeight
    const metrics = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 - 320 };
    // distance = 1000 - 280 - 400 = 320 === threshold → near
    expect(isNearBottom(metrics, 320)).toBe(true);
    expect(isNearBottom({ ...metrics, scrollTop: metrics.scrollTop - 1 }, 320)).toBe(false);
  });

  it("is true once scrolled to the very bottom", () => {
    expect(isNearBottom({ scrollHeight: 5000, clientHeight: 800, scrollTop: 4200 }, 320)).toBe(
      true,
    );
  });

  it("is false near the top of a long list", () => {
    expect(isNearBottom({ scrollHeight: 5000, clientHeight: 800, scrollTop: 0 }, 320)).toBe(false);
  });

  it("exposes the runs-shell default threshold", () => {
    expect(DEFAULT_END_REACHED_THRESHOLD).toBe(320);
  });
});

describe("scroll position store", () => {
  it("round-trips a saved offset by id", () => {
    clearScrollPosition("runs");
    expect(readScrollPosition("runs")).toBeUndefined();
    saveScrollPosition("runs", 742);
    expect(readScrollPosition("runs")).toBe(742);
  });

  it("keeps ids independent and clears one without touching the other", () => {
    saveScrollPosition("a", 10);
    saveScrollPosition("b", 20);
    clearScrollPosition("a");
    expect(readScrollPosition("a")).toBeUndefined();
    expect(readScrollPosition("b")).toBe(20);
  });
});

describe("resolveActiveStickyIndex", () => {
  // Sections at rows 0, 4 and 9 (e.g. the tool tree's per-account headers).
  const sticky = [0, 4, 9];

  it("pins the first header while scrolled within the first section", () => {
    expect(resolveActiveStickyIndex(sticky, 0)).toBe(0);
    expect(resolveActiveStickyIndex(sticky, 3)).toBe(0);
  });

  it("switches to the header at the section boundary", () => {
    expect(resolveActiveStickyIndex(sticky, 4)).toBe(4);
    expect(resolveActiveStickyIndex(sticky, 8)).toBe(4);
    expect(resolveActiveStickyIndex(sticky, 9)).toBe(9);
    expect(resolveActiveStickyIndex(sticky, 50)).toBe(9);
  });

  it("returns null when no header is at or above the first visible row", () => {
    // A list whose first sticky header isn't at the very top.
    expect(resolveActiveStickyIndex([2, 5], 0)).toBeNull();
    expect(resolveActiveStickyIndex([2, 5], 1)).toBeNull();
    expect(resolveActiveStickyIndex([], 7)).toBeNull();
  });
});
