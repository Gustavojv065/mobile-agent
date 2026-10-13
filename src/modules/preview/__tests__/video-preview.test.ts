import { describe, expect, it, vi } from "vitest";

import {
  hasScenePreviewHost,
  requestScenePreview,
  subscribeScenePreview,
  type ScenePreviewJob,
} from "@/modules/preview/video-preview";

const HTML =
  "<html><script>window.MOBILE_AGENT_VIDEO = { duration: 6 };</script></html>";

describe("requestScenePreview", () => {
  it("rejects HTML without the scene contract", async () => {
    await expect(requestScenePreview("<p>nope</p>", { times: [0] })).rejects.toThrow(
      /MOBILE_AGENT_VIDEO/,
    );
  });

  it("rejects an empty timestamp list", async () => {
    await expect(requestScenePreview(HTML, { times: [] })).rejects.toThrow(
      /timestamp/,
    );
    await expect(
      requestScenePreview(HTML, { times: [NaN, -1] }),
    ).rejects.toThrow(/timestamp/);
  });

  it("rejects when no host is mounted", async () => {
    expect(hasScenePreviewHost()).toBe(false);
    await expect(requestScenePreview(HTML, { times: [0] })).rejects.toThrow(
      /only available on Android/,
    );
  });

  it("hands the job to the host and resolves with its result", async () => {
    const seen: ScenePreviewJob[] = [];
    const unsubscribe = subscribeScenePreview((job) => {
      seen.push(job);
      job.resolve({
        frames: [{ time: 0, width: 1280, height: 720, base64: "QUJD" }],
        warnings: [],
      });
    });
    try {
      expect(hasScenePreviewHost()).toBe(true);
      const result = await requestScenePreview(HTML, { times: [0, 3] });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ html: HTML, times: [0, 3] });
      expect(result.frames).toHaveLength(1);
    } finally {
      unsubscribe();
    }
    expect(hasScenePreviewHost()).toBe(false);
  });

  it("honors an already-aborted signal", async () => {
    const unsubscribe = subscribeScenePreview(() => {
      throw new Error("host must not run");
    });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        requestScenePreview(HTML, { times: [0], signal: controller.signal }),
      ).rejects.toThrow(/cancelled/);
    } finally {
      unsubscribe();
    }
  });

  it("propagates host failures", async () => {
    const onRecord = vi.fn();
    const unsubscribe = subscribeScenePreview((job) => {
      onRecord(job.id);
      job.reject(new Error("WebView exploded"));
    });
    try {
      await expect(requestScenePreview(HTML, { times: [0] })).rejects.toThrow(
        /exploded/,
      );
      expect(onRecord).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });
});
