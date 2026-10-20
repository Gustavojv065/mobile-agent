import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sizes: new Map<string, number>(),
  unreadable: false,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    size: number | null;
    constructor(uri: string) {
      if (mocks.unreadable) throw new Error("file is unreadable");
      this.size = mocks.sizes.get(uri) ?? null;
    }
  },
}));

const { BLANK_CAPTURE_MAX_BYTES, isBlankCapture } = await import(
  "@/modules/preview/view-shot"
);

describe("isBlankCapture", () => {
  it("flags a capture too small to hold a rendered page", () => {
    mocks.sizes.set("file:///blank.png", BLANK_CAPTURE_MAX_BYTES - 1);
    expect(isBlankCapture("file:///blank.png")).toBe(true);
  });

  it("flags a capture that never produced a file", () => {
    expect(isBlankCapture("file:///missing.png")).toBe(true);
  });

  it("passes a capture that holds a real page", () => {
    mocks.sizes.set("file:///page.png", BLANK_CAPTURE_MAX_BYTES * 4);
    expect(isBlankCapture("file:///page.png")).toBe(false);
  });

  it("treats an unreadable file as unknown rather than blank", () => {
    mocks.unreadable = true;
    expect(isBlankCapture("file:///page.png")).toBe(false);
    mocks.unreadable = false;
  });
});
