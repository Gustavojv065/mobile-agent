export type SliderRange = {
  maximumValue: number;
  minimumValue: number;
  step: number;
};

/**
 * Maps a contiguous touch position to a stepped slider value.
 *
 * `position` is the horizontal distance from the track's left edge in
 * pixels, clamped to [0, width]; the ratio then maps onto
 * minimumValue..maximumValue and snaps to `step`. Degenerate tracks
 * (zero/negative width) return the value at the clamped edge.
 */
export function computeSliderValue(
  position: number,
  trackWidth: number,
  range: SliderRange,
): number {
  const { maximumValue, minimumValue, step } = range;
  const span = maximumValue - minimumValue;
  if (!(trackWidth > 0) || span <= 0) {
    return Math.min(maximumValue, Math.max(minimumValue, minimumValue));
  }
  const ratio = Math.min(1, Math.max(0, position / trackWidth));
  const raw = minimumValue + ratio * span;
  const stepped = Math.round(raw / step) * step;
  const clamped = Math.min(maximumValue, Math.max(minimumValue, stepped));
  // Trim float drift (0.30000000000000004) so values stay deterministic.
  return Number(clamped.toFixed(4));
}
