import { describe, expect, it } from "vitest";

import {
  MIX_JOB_TIMEOUT_MS,
  RENDER_PAGE_SILENCE_MS,
  SCENE_PREVIEW_JOB_TIMEOUT_MS,
  SCENE_PREVIEW_START_TIMEOUT_MS,
  mixJobTimeoutError,
  renderPageInactivityError,
  scenePreviewJobTimeoutError,
  scenePreviewStartTimeoutError,
} from "@/modules/preview/video-job-bounds";

const HTML = "<html></html>".repeat(10);

describe("video job bounds", () => {
  it("starts inside and finishes well under the run-level inactivity timeout", () => {
    // A 5 min run-level inactivity abort must never be the first responder for
    // any of these lanes; that abort was recorded as "Run completed".
    expect(MIX_JOB_TIMEOUT_MS).toBeLessThan(5 * 60_000);
    expect(RENDER_PAGE_SILENCE_MS).toBeLessThan(5 * 60_000);
    expect(SCENE_PREVIEW_JOB_TIMEOUT_MS).toBeLessThan(5 * 60_000);
    expect(SCENE_PREVIEW_START_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SCENE_PREVIEW_JOB_TIMEOUT_MS).toBeGreaterThan(
      SCENE_PREVIEW_START_TIMEOUT_MS,
    );
    // The 180s pair derives from the same served-audio decode mathematics.
    expect(MIX_JOB_TIMEOUT_MS).toBe(RENDER_PAGE_SILENCE_MS);
    expect(MIX_JOB_TIMEOUT_MS).toBeGreaterThan(SCENE_PREVIEW_JOB_TIMEOUT_MS);
  });

  it("builds the preview errors with bound-derived seconds and details", () => {
    const job = { html: HTML, times: [1, 2, 3] };
    expect(scenePreviewStartTimeoutError(job).message).toContain(
      "did not start within 15s (3 timestamps",
    );
    expect(scenePreviewJobTimeoutError(job, 2).message).toContain(
      "timed out after 60s (2/3 frames captured, 3 timestamps",
    );
  });

  it("builds the mix error from its bound, not a duplicated literal", () => {
    const message = mixJobTimeoutError({ html: HTML }).message;
    expect(message).toContain(`timed out after ${Math.round(MIX_JOB_TIMEOUT_MS / 1000)}s`);
    expect(message).toContain(`${HTML.length}-char document`);
  });

  it("reports the render stall with progress, segment, and resume note", () => {
    const error = renderPageInactivityError({
      progressPercent: 47,
      html: HTML,
      segment: "segment 30-60s",
    });
    expect(error.message).toContain("no page activity for 180s");
    expect(error.message).toContain("last progress 47%");
    expect(error.message).toContain("segment 30-60s");
    expect(error.message).toContain("finished segments resume on retry");

    const whole = renderPageInactivityError({
      progressPercent: 0,
      html: HTML,
      segment: null,
    });
    expect(whole.message).toContain("last progress 0%,");
    expect(whole.message).not.toContain("undefined");
  });
});
