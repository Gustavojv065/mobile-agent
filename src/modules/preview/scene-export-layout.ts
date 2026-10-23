export type SceneExportPhase = "preparing" | "recording" | "finishing";

/** Preview state is not export state. Once suspended, never leave its
 * transport or audio-loading badge over the export thumbnail. */
export function sceneExportPresentation(
  phase: SceneExportPhase | null,
  previewSuspended: boolean,
  audioLoading: boolean,
) {
  const showPlayerChrome = phase === null && !previewSuspended;
  return {
    showPlayerChrome,
    showLivePreview: !previewSuspended && (phase === null || phase === "preparing"),
    showAudioLoading: showPlayerChrome && audioLoading,
  };
}

export function sceneExportGeometry(width: number, height: number, progress: number) {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const fraction = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  // The stroke's OUTER edge follows the card edge. Its only visible gap is
  // between the progress head and tail, not a second inset card outline.
  const strokeWidth = Math.min(3, safeWidth / 4, safeHeight / 4);
  const inset = strokeWidth / 2;
  const w = safeWidth - inset * 2;
  const h = safeHeight - inset * 2;
  const radius = Math.max(0, Math.min(24 - inset, w / 2, h / 2));
  const perimeter = Math.max(0, 2 * (w + h) - 8 * radius + 2 * Math.PI * radius);
  // Rounded caps must not meet/overlap at the path's start, even at 100%.
  const endGap = Math.min(8, perimeter / 4);
  const length = Math.max(0, (perimeter - endGap) * fraction - strokeWidth);
  return {
    inset, strokeWidth, width: w, height: h, radius, perimeter, length,
    percent: fraction === 1 ? 100 : Math.floor(fraction * 1000 + 1e-8) / 10,
  };
}
