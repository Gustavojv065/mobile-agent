import { describe, expect, it } from "vitest";

import {
  clearHighlightCache,
  computeHighlightRuns,
  getSyntaxTokenKind,
  splitRunsIntoLines,
  SYNTAX_KIND_CLASSES,
} from "@/modules/chat/syntax-highlight-core";

describe("computeHighlightRuns", () => {
  it("returns null for an unregistered language", () => {
    expect(computeHighlightRuns("const x = 1", "cobol")).toBeNull();
  });

  it("returns null without a language", () => {
    expect(computeHighlightRuns("const x = 1", ""))
      .toBeNull();
  });

  it("annotates a tsx keyword run", () => {
    clearHighlightCache();
    const runs = computeHighlightRuns("const x = 1;", "tsx");

    expect(runs).not.toBeNull();
    const keywordRun = runs!.find((run) => run.kind === "keyword");
    expect(keywordRun).toEqual({ kind: "keyword", text: "const" });
  });

  it("leaves the source intact across runs", () => {
    const code = "const value = (query: string) => `x${query}`;\n";
    const runs = computeHighlightRuns(code, "tsx");

    expect(runs!.map((run) => run.text).join("")).toBe(code);
  });

  it("renders ansi colors as token kinds and keeps escape codes out", () => {
    const runs = computeHighlightRuns(
      "\u001b[32m✓ passed\u001b[39m plain \u001b[31mfailed\u001b[0m",
      "ansi",
    );

    expect(runs).toEqual([
      { kind: "string", text: "✓ passed" },
      { kind: "default", text: " plain " },
      { kind: "constant", text: "failed" },
    ]);
  });
});

describe("splitRunsIntoLines", () => {
  it("splits runs at newline boundaries, dropping the separators", () => {
    const lines = splitRunsIntoLines([
      { kind: "keyword", text: "const" },
      { kind: "default", text: " x = 1;\nconst" },
      { kind: "default", text: " y = 2;\n" },
    ]);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([
      { kind: "keyword", text: "const" },
      { kind: "default", text: " x = 1;" },
    ]);
    expect(lines[1]).toEqual([
      { kind: "default", text: "const" },
      { kind: "default", text: " y = 2;" },
    ]);
    expect(lines[2]).toEqual([]);
  });

  it("preserves blank lines as empty run arrays", () => {
    const lines = splitRunsIntoLines([{ kind: "default", text: "a\n\nb" }]);

    expect(lines).toHaveLength(3);
    expect(lines[1]).toEqual([]);
  });
});

describe("getSyntaxTokenKind", () => {
  it("maps prism class names to token kinds", () => {
    expect(getSyntaxTokenKind(["keyword", "directive"])).toBe("keyword");
    expect(getSyntaxTokenKind(["attr-name"])).toBe("string");
    expect(getSyntaxTokenKind(["unknown-class"])).toBe("default");
  });

  it("keeps kind lists flat and non-overlapping", () => {
    const seen = new Map<string, string>();
    for (const [kind, classes] of Object.entries(SYNTAX_KIND_CLASSES)) {
      if (kind === "default") continue;
      for (const className of classes) {
        expect(seen.has(className), className).toBe(false);
        seen.set(className, kind);
      }
    }
  });
});
