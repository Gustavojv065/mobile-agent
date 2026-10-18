import { describe, expect, it } from "vitest";

import { buildLineDiff, countDiffLines } from "@/modules/files/line-diff";

describe("buildLineDiff", () => {
  it("returns null when there is nothing to show", () => {
    const text = "const a = 1;\nconst b = 2;";
    expect(buildLineDiff(text, text)).toBeNull();
  });

  it("returns null when either side is too large to diff", () => {
    const big = Array.from({ length: 501 }, (_, i) => `line ${i}`);
    expect(buildLineDiff(big.join("\n"), "something")).toBeNull();
  });

  it("reports a replaced line as a single hunk with one added and one removed", () => {
    const diff = buildLineDiff(
      "const a = 1;\nconst b = 2;\nconst c = 3;",
      "const a = 1;\nconst b = 20;\nconst c = 3;",
    );

    expect(diff).not.toBeNull();
    expect(diff?.added).toBe(1);
    expect(diff?.removed).toBe(1);
    expect(diff?.hunkCount).toBe(1);
    expect(diff?.hunkText).toMatch(/-const b = 2;/);
    expect(diff?.hunkText).toMatch(/\+const b = 20;/);
    expect(diff?.truncated).toBe(false);
  });

  it("keeps a few context lines around each change", () => {
    const before = [
      ...Array.from({ length: 10 }, (_, i) => `unchanged ${i}`),
      "changed line",
      ...Array.from({ length: 10 }, (_, i) => `trailing ${i}`),
    ].join("\n");
    const after = before.replace("changed line", "edited line");
    const diff = buildLineDiff(before, after);

    const lines = diff?.hunkText.split("\n") ?? [];
    // hunk header, ≤3 leading context, -old, +new, ≤3 trailing context.
    expect(lines.length).toBeLessThanOrEqual(9);
    const contextCount = lines.filter((line) => line.startsWith(" ")).length;
    expect(contextCount).toBeLessThanOrEqual(6);
  });

  it("merges changes that sit closer than the context span", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
    // Two adjacent changes with only 2 keeps between them belong to one hunk.
    const diff = buildLineDiff(before, "a\nB\nc\nd\nE\nf\ng\nh\ni\nj");

    expect(diff?.hunkCount).toBe(1);
    expect(diff?.added).toBe(2);
    expect(diff?.removed).toBe(2);
  });

  it("separates changes that are far apart", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const after = before
      .replace("line 5", "LINE 5")
      .replace("line 30", "LINE 30");
    const diff = buildLineDiff(before, after);

    expect(diff?.hunkCount).toBe(2);
  });

  it("counts every change in the stat, even when hunks are truncated", () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    // 12 separate edits, one per each 15th line → more than MAX_HUNKS hunks.
    const after = before
      .split("\n")
      .map((line, index) =>
        index % 15 === 0 ? `${line} (edited)` : line,
      )
      .join("\n");
    const diff = buildLineDiff(before, after);

    expect(diff?.truncated).toBe(true);
    // 200 lines / 15 → 14 edit sites, so 14 added + 14 removed even though
    // only the first hunks are emitted.
    expect(diff?.added).toBe(14);
    expect(diff?.removed).toBe(14);
    expect(diff?.hunkText).toMatch(/more added and .* more removed lines not shown/);
  });

  it("handles changes at the very first and last lines", () => {
    expect(buildLineDiff("a\nb\nc", "A\nb\nc")?.removed).toBe(1);
    expect(buildLineDiff("a\nb\nc", "a\nb\nc\nadded tail")?.added).toBe(1);
  });
});

describe("countDiffLines", () => {
  it("counts the + and - content lines of a rendered diff", () => {
    expect(
      countDiffLines("@@ line 2 @@\n-const b = 2;\n+const b = 20;\n const c = 3;"),
    ).toEqual({ added: 1, removed: 1 });
  });
});
