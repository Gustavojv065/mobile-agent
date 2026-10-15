import { describe, expect, it, vi } from "vitest";

import {
  hasPageShotHost,
  requestPageShot,
  subscribePageShot,
} from "@/modules/preview/page-shot";

describe("page-shot queue", () => {
  it("rejects fast with no host mounted", async () => {
    expect(hasPageShotHost()).toBe(false);
    await expect(requestPageShot({ url: "https://example.com" })).rejects.toThrow(
      /Android/,
    );
  });

  it("rejects cancelled requests without enqueueing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestPageShot({ url: "https://example.com", signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });

  it("delivers jobs to the subscriber and resolves", async () => {
    const seen: string[] = [];
    const unsub = subscribePageShot((job) => {
      seen.push(job.url);
      job.resolve({ tmpUri: "file:///cache/shot.png" });
    });
    try {
      expect(hasPageShotHost()).toBe(true);
      const result = await requestPageShot({ url: "https://example.com" });
      expect(result).toEqual({ tmpUri: "file:///cache/shot.png" });
      expect(seen).toEqual(["https://example.com"]);
    } finally {
      unsub();
    }
    expect(hasPageShotHost()).toBe(false);
  });
});
