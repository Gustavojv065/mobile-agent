import { describe, expect, it, vi } from "vitest";
import { createThumbnailQueue } from "@/modules/files/thumbnail-queue";

describe("thumbnail decode queue", () => {
  it("bounds concurrency even with 260 selected images", async () => {
    const enqueue = createThumbnailQueue(2);
    let active = 0;
    let peak = 0;
    const loads = Array.from({ length: 260 }, (_, index) => enqueue(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return index;
    }, new AbortController().signal));
    expect(await Promise.all(loads)).toEqual(Array.from({ length: 260 }, (_, i) => i));
    expect(peak).toBe(2);
  });

  it("does not decode queued rows that were unmounted", async () => {
    const enqueue = createThumbnailQueue(1);
    let finish!: () => void;
    const first = enqueue(() => new Promise<void>((resolve) => { finish = resolve; }), new AbortController().signal);
    await Promise.resolve();
    const controller = new AbortController();
    const load = vi.fn(async () => "unused");
    const queued = enqueue(load, controller.signal);
    controller.abort();
    expect(await queued).toBeNull();
    finish();
    await first;
    expect(load).not.toHaveBeenCalled();
  });

  it("continues after a failed decode", async () => {
    const enqueue = createThumbnailQueue(1);
    const failed = enqueue(async () => { throw new Error("bad image"); }, new AbortController().signal);
    const next = enqueue(async () => "next", new AbortController().signal);
    await expect(failed).rejects.toThrow("bad image");
    expect(await next).toBe("next");
  });
});
