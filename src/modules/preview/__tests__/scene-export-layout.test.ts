import { describe, expect, it } from "vitest";
import { sceneExportGeometry, sceneExportPresentation } from "../scene-export-layout";

describe("export presentation", () => {
  it.each(["preparing", "recording", "finishing"] as const)("hides transport and stale audio readiness while %s", (phase) => {
    const state = sceneExportPresentation(phase, false, true);
    expect(state.showPlayerChrome).toBe(false);
    expect(state.showAudioLoading).toBe(false);
    expect(state.showLivePreview).toBe(phase === "preparing");
  });

  it("restores preview controls and its own audio indicator after export", () => {
    expect(sceneExportPresentation(null, false, true)).toEqual({
      showPlayerChrome: true, showLivePreview: true, showAudioLoading: true,
    });
    expect(sceneExportPresentation(null, true, true)).toEqual({
      showPlayerChrome: false, showLivePreview: false, showAudioLoading: false,
    });
  });
});

describe("edge-aligned export progress ring", () => {
  it("sits flush with the card edge but keeps the head/tail gap at full progress", () => {
    const g = sceneExportGeometry(340, 190, 1);
    expect(g.inset - g.strokeWidth / 2).toBe(0);
    expect(g.length + g.strokeWidth).toBeLessThanOrEqual(g.perimeter - 8);
    expect(g.radius + g.strokeWidth / 2).toBe(24);
  });

  it("is empty at zero and does not claim completion by rounding up", () => {
    expect(sceneExportGeometry(340, 190, 0).length).toBe(0);
    expect(sceneExportGeometry(340, 190, 0.425).percent).toBe(42.5);
    expect(sceneExportGeometry(340, 190, 0.999).percent).toBe(99.9);
    expect(sceneExportGeometry(340, 190, 1).percent).toBe(100);
  });

  it.each([[0, 0, NaN], [4, 3, -1], [200, 500, 2], [NaN, Infinity, 0.5]])("keeps geometry finite and inside a %s x %s box", (w, h, progress) => {
    const g = sceneExportGeometry(w, h, progress);
    for (const value of Object.values(g)) expect(Number.isFinite(value)).toBe(true);
    expect(g.width).toBeGreaterThanOrEqual(0);
    expect(g.height).toBeGreaterThanOrEqual(0);
    expect(g.radius).toBeGreaterThanOrEqual(0);
    expect(g.percent).toBeGreaterThanOrEqual(0);
    expect(g.percent).toBeLessThanOrEqual(100);
  });
});
