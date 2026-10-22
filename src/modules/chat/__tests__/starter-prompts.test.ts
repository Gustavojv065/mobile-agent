import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STARTER_PROMPTS,
  fetchStarterPrompts,
  MAX_STARTER_PROMPTS,
  MAX_STARTER_PROMPT_LABEL_LENGTH,
  MAX_STARTER_PROMPT_LENGTH,
  parseStarterPrompts,
} from "@/modules/chat/starter-prompts";

afterEach(() => vi.unstubAllGlobals());

function prompts(list: unknown[], enabled = true) {
  return { version: 1, enabled, prompts: list };
}

describe("starter prompts", () => {
  it("ships a valid offline default", () => {
    expect(DEFAULT_STARTER_PROMPTS.enabled).toBe(true);
    expect(DEFAULT_STARTER_PROMPTS.prompts.length).toBeGreaterThan(0);
    expect(DEFAULT_STARTER_PROMPTS.prompts[0].label).toBeTruthy();
    expect(DEFAULT_STARTER_PROMPTS.prompts[0].prompt).toBeTruthy();
  });

  it("flattens label whitespace and preserves newlines in the prompt", () => {
    expect(parseStarterPrompts(prompts([
      { label: "  Design\na page ", prompt: "Design a page.\n\nUse a clean layout." },
    ])).prompts).toEqual([
      { label: "Design a page", prompt: "Design a page.\n\nUse a clean layout." },
    ]);
  });

  it("allows disabling the prompts remotely", () => {
    expect(parseStarterPrompts(prompts([], false))).toEqual({ enabled: false, prompts: [] });
  });

  it("limits the number of prompts", () => {
    const entry = { label: "Idea", prompt: "Do a thing" };
    expect(() => parseStarterPrompts(prompts(
      Array.from({ length: MAX_STARTER_PROMPTS + 1 }, () => entry),
    ))).toThrow();
    expect(() => parseStarterPrompts(prompts(
      Array.from({ length: MAX_STARTER_PROMPTS }, () => entry),
    ))).not.toThrow();
  });

  it("enforces label and prompt length limits", () => {
    expect(() => parseStarterPrompts(prompts([
      { label: "a".repeat(MAX_STARTER_PROMPT_LABEL_LENGTH + 1), prompt: "Do a thing" },
    ]))).toThrow("label");
    expect(() => parseStarterPrompts(prompts([
      { label: "Idea", prompt: "a".repeat(MAX_STARTER_PROMPT_LENGTH + 1) },
    ]))).toThrow("at most");
  });

  it.each([
    null,
    { version: 2, enabled: true, prompts: [{ label: "Idea", prompt: "Do a thing" }] },
    { version: 1, enabled: "yes", prompts: [] },
    prompts([]),
    prompts([{ label: "  ", prompt: "Do a thing" }]),
    prompts([{ label: "Idea", prompt: "   " }]),
    prompts([{ label: 123, prompt: "Do a thing" }]),
  ])("rejects malformed content: %j", (value) => {
    expect(() => parseStarterPrompts(value)).toThrow();
  });

  it("fetches and validates remote prompts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(
      prompts([{ label: "Remote idea", prompt: "Do a remote thing" }]),
    )));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchStarterPrompts()).prompts[0].label).toBe("Remote idea");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects failed requests so the query keeps its existing prompts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(fetchStarterPrompts()).rejects.toThrow("404");
  });

  it("rejects oversized payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(" ".repeat(16_385))));
    await expect(fetchStarterPrompts()).rejects.toThrow("too large");
  });
});
