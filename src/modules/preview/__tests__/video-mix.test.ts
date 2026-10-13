import { describe, expect, it, vi } from "vitest";

import {
  hasMixCheckHost,
  requestMixCheck,
  subscribeMixCheck,
  type MixCheckJob,
} from "@/modules/preview/video-mix";

const HTML =
  "<html><script>window.MOBILE_AGENT_VIDEO = { duration: 6 };</script></html>";

describe("requestMixCheck", () => {
  it("rejects HTML without the scene contract", async () => {
    await expect(requestMixCheck("<p>nope</p>", { duration: 6 })).rejects.toThrow(
      /MOBILE_AGENT_VIDEO/,
    );
  });

  it("rejects a non-positive duration", async () => {
    await expect(requestMixCheck(HTML, { duration: 0 })).rejects.toThrow(
      /duration/,
    );
    await expect(requestMixCheck(HTML, { duration: -2 })).rejects.toThrow(
      /duration/,
    );
  });

  it("rejects when no host is mounted", async () => {
    expect(hasMixCheckHost()).toBe(false);
    await expect(requestMixCheck(HTML, { duration: 6 })).rejects.toThrow(
      /only available on Android/,
    );
  });

  it("hands the job to the host and resolves with its result", async () => {
    const seen: MixCheckJob[] = [];
    const unsubscribe = subscribeMixCheck((job) => {
      seen.push(job);
      job.resolve({
        stats: {
          peak: 0.7,
          rms: 0.3,
          clipped: false,
          clippedRanges: [],
          quietRanges: [],
          duckedRanges: [],
          duration: 6,
        },
        warnings: [],
      });
    });
    try {
      expect(hasMixCheckHost()).toBe(true);
      const result = await requestMixCheck(HTML, { duration: 6 });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ html: HTML, duration: 6 });
      expect(result.stats?.peak).toBe(0.7);
    } finally {
      unsubscribe();
    }
    expect(hasMixCheckHost()).toBe(false);
  });

  it("honors an already-aborted signal", async () => {
    const unsubscribe = subscribeMixCheck(() => {
      throw new Error("host must not run");
    });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        requestMixCheck(HTML, { duration: 6, signal: controller.signal }),
      ).rejects.toThrow(/cancelled/);
    } finally {
      unsubscribe();
    }
  });

  it("propagates host failures", async () => {
    const onRecord = vi.fn();
    const unsubscribe = subscribeMixCheck((job) => {
      onRecord(job.id);
      job.reject(new Error("offline exploded"));
    });
    try {
      await expect(requestMixCheck(HTML, { duration: 6 })).rejects.toThrow(
        /exploded/,
      );
      expect(onRecord).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });
});
