/** Clamps a 0..1 download fraction for display (unknown length reads as 0). */
export function progressPercent(progress: number) {
  const value =
    Number.isFinite(progress) && progress > 0 ? Math.min(progress, 1) : 0;
  return Math.round(value * 100);
}

/** Same fraction as a label with one decimal, e.g. `42.5%`. */
export function progressLabel(progress: number) {
  const value =
    Number.isFinite(progress) && progress > 0 ? Math.min(progress, 1) : 0;
  return `${(value * 100).toFixed(1)}%`;
}
