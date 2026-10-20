import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_CAPTURE_TIMEOUT_MS,
  BROWSER_COMMAND_TIMEOUT_MS,
  BROWSER_MAX_SLICES,
  BROWSER_PAGE_LOAD_TIMEOUT_MS,
  browserCommandBudgetMs,
  browserCommandTimeoutError,
  browserLoadTimeoutError,
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

describe("browser command budget", () => {
  it("gives a full-page screenshot room for every capture", () => {
    const budget = browserCommandBudgetMs({
      kind: "screenshot",
      fullPage: true,
      maxSlices: 4,
    });
    // One overview plus four slices, each with its own capture allowance.
    expect(budget).toBe(
      BROWSER_COMMAND_TIMEOUT_MS + BROWSER_CAPTURE_TIMEOUT_MS * 5,
    );
  });

  it("caps the full-page budget at the maximum slice count", () => {
    const budget = browserCommandBudgetMs({
      kind: "screenshot",
      fullPage: true,
      maxSlices: BROWSER_MAX_SLICES * 4,
    });
    expect(budget).toBe(
      BROWSER_COMMAND_TIMEOUT_MS +
        BROWSER_CAPTURE_TIMEOUT_MS * (BROWSER_MAX_SLICES + 1),
    );
  });

  it("keeps a viewport screenshot on the single-command budget", () => {
    expect(
      browserCommandBudgetMs({ kind: "screenshot", fullPage: false }),
    ).toBe(BROWSER_COMMAND_TIMEOUT_MS);
  });

  it("gives page loads the load budget", () => {
    expect(browserCommandBudgetMs({ kind: "navigate", url: "https://x" })).toBe(
      BROWSER_PAGE_LOAD_TIMEOUT_MS,
    );
  });

  it("reports the real budget in the timeout message", () => {
    const command = { kind: "screenshot", fullPage: true, maxSlices: 4 } as const;
    const seconds = Math.round(browserCommandBudgetMs(command) / 1000);
    expect(browserCommandTimeoutError(command).message).toContain(
      `timed out after ${seconds}s`,
    );
    expect(browserCommandTimeoutError(command).message).toContain(
      "full-page screenshot",
    );
  });

  it("reports the load budget in the navigation timeout message", () => {
    const command = { kind: "navigate", url: "https://x" } as const;
    expect(browserLoadTimeoutError(command).message).toContain(
      `timed out after ${Math.round(BROWSER_PAGE_LOAD_TIMEOUT_MS / 1000)}s`,
    );
  });
});
