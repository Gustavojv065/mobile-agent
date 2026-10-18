import { describe, expect, it, vi } from "vitest";

import {
  hasBrowserHost,
  requestBrowserCommand,
  subscribeBrowser,
  type BrowserCommandWithResult,
} from "@/modules/preview/browser-session";

describe("browser session queue", () => {
  it("rejects when no host is registered", async () => {
    expect(hasBrowserHost()).toBe(false);
    await expect(
      requestBrowserCommand({ command: { kind: "navigate", url: "https://example.com" } }),
    ).rejects.toThrow(/only available on Android/);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const unsubscribe = subscribeBrowser(() => {});
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestBrowserCommand({
        command: { kind: "read" },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);

    unsubscribe();
  });

  it("hands the command to a subscriber and resolves with its result", async () => {
    const listener = vi.fn((job: BrowserCommandWithResult) => {
      job.resolve({ kind: "read", url: "https://example.com", title: "Example", text: "hi", links: [] });
    });
    const unsubscribe = subscribeBrowser(listener);

    const result = await requestBrowserCommand({ command: { kind: "read" } });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: "read",
      url: "https://example.com",
      title: "Example",
      text: "hi",
      links: [],
    });

    unsubscribe();
  });

  it("stops notifying unsubscribed listeners", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBrowser(listener);
    unsubscribe();

    await expect(requestBrowserCommand({ command: { kind: "read" } })).rejects.toThrow(
      /only available on Android/,
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
