import { describe, expect, it } from "vitest";

import { computeSliderValue } from "@/components/ui/slider-math";

const SECONDS = { maximumValue: 30, minimumValue: 0, step: 0.05 };

describe("computeSliderValue", () => {
  it("maps a tap at the middle of the track to the middle value", () => {
    expect(computeSliderValue(150, 300, SECONDS)).toBe(15);
  });

  it("maps a tap near the left edge to a small value, not the opposite end", () => {
    expect(computeSliderValue(6, 300, SECONDS)).toBe(0.6);
  });

  it("maps the right edge to the maximum", () => {
    expect(computeSliderValue(300, 300, SECONDS)).toBe(30);
  });

  it("matches the reported bug: a tap just past the thumb no longer jumps to max", () => {
    // 10s scene, thumb near 3s tapped at 3.5s on a ~250px track.
    expect(computeSliderValue(36.5, 260, { maximumValue: 10, minimumValue: 0, step: 0.05 })).toBe(1.4);
  });

  it("snaps to step and clamps", () => {
    expect(computeSliderValue(150, 300, { maximumValue: 10, minimumValue: 0, step: 1 })).toBe(5);
    expect(computeSliderValue(-50, 300, SECONDS)).toBe(0);
    expect(computeSliderValue(9999, 300, SECONDS)).toBe(30);
  });

  it("handles a not-yet-measured track without throwing", () => {
    expect(computeSliderValue(150, 0, SECONDS)).toBe(0);
  });

  it("handles single-value ranges", () => {
    expect(computeSliderValue(150, 300, { maximumValue: 5, minimumValue: 5, step: 0.01 })).toBe(5);
  });
});
