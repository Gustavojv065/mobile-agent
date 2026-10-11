import { describe, expect, it } from "vitest";

import { recognizeImageText } from "@/modules/documents/ocr";

describe("recognizeImageText", () => {
  it("degrades gracefully when the native module is unavailable", async () => {
    // In a Node/vitest environment there is no native ExpoTextExtractor
    // module, so the guarded dynamic import must report the feature as
    // unavailable instead of crashing.
    const result = await recognizeImageText("file:///tmp/test.png");

    expect(result.available).toBe(false);
    expect(result.text).toBe("");
    expect(result.lines).toEqual([]);
    expect(result.reason).toMatch(/not available/);
  });
});