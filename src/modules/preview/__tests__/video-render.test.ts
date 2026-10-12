import { describe, expect, it, vi } from "vitest";

import {
  hasVideoRenderHost,
  requestVideoRender,
  subscribeVideoRender,
} from "@/modules/preview/video-render";

const CONTRACT_HTML =
  '<html><script>window.MOBILE_AGENT_VIDEO = { duration: 1, render: function () {} };</script></html>';

describe("requestVideoRender", () => {
  it("rejects documents that do not implement the contract", async () => {
    const unsubscribe = subscribeVideoRender(() => {});
    await expect(requestVideoRender("<html></html>")).rejects.toThrow(
      /MOBILE_AGENT_VIDEO/,
    );
    unsubscribe();
  });

  it("rejects when no host is registered", async () => {
    expect(hasVideoRenderHost()).toBe(false);
    await expect(requestVideoRender(CONTRACT_HTML)).rejects.toThrow(
      /only available on Android/,
    );
  });

  it("hands the job to a subscriber and resolves with its result", async () => {
    const listener = vi.fn(
      (job: Parameters<Parameters<typeof subscribeVideoRender>[0]>[0]) => {
        job.resolve({ uri: "file:///cache/v.mp4", sizeBytes: 42, hasAudio: false, audioWarnings: [] });
      },
    );
    const unsubscribe = subscribeVideoRender(listener);

    const result = await requestVideoRender(CONTRACT_HTML);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ uri: "file:///cache/v.mp4", sizeBytes: 42, hasAudio: false, audioWarnings: [] });

    unsubscribe();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const unsubscribe = subscribeVideoRender(() => {});
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestVideoRender(CONTRACT_HTML, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);

    unsubscribe();
  });

  it("stops notifying unsubscribed listeners", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVideoRender(listener);
    unsubscribe();

    await expect(requestVideoRender(CONTRACT_HTML)).rejects.toThrow(
      /only available on Android/,
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
