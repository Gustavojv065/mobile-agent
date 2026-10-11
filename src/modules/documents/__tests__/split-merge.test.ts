import { describe, expect, it } from "vitest";

import {
  mergeDocumentSources,
  splitDocumentSource,
} from "@/modules/documents/split-merge";

const SOURCE = `# Title

Intro paragraph.

## One

First body.

## Two

Second body.

## Three

Third body.
`;

const FRONT_MATTER_SOURCE = `---
format:
  page:
    size: LETTER
---

# Title

Intro paragraph.

## One

First body.
`;

describe("splitDocumentSource", () => {
  it("splits by 0-based section ranges", () => {
    const { parts, sectionCount } = splitDocumentSource({
      source: SOURCE,
      spec: "0-1,2",
    });

    expect(sectionCount).toBe(4);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      title: "Title",
      sectionIndices: [0, 1],
    });
    expect(parts[0]!.source).toBe(
      "# Title\n\nIntro paragraph.\n\n## One\n\nFirst body.\n",
    );
    expect(parts[1]).toMatchObject({
      title: "Two",
      sectionIndices: [2],
    });
    expect(parts[1]!.source).toBe("## Two\n\nSecond body.\n");
  });

  it("makes one part per section with 'each'", () => {
    const { parts } = splitDocumentSource({ source: SOURCE, spec: "each" });

    expect(parts).toHaveLength(4);
    expect(parts.map((part) => part.title)).toEqual([
      "Title",
      "One",
      "Two",
      "Three",
    ]);
    expect(parts.map((part) => part.sectionIndices)).toEqual([
      [0],
      [1],
      [2],
      [3],
    ]);
  });

  it("reassembles to the original source", () => {
    const { parts } = splitDocumentSource({ source: SOURCE, spec: "each" });

    expect(parts.map((part) => part.source).join("\n")).toBe(SOURCE);
  });

  it("copies front-matter into every part but keeps the preamble only in the first", () => {
    const { parts } = splitDocumentSource({
      source: FRONT_MATTER_SOURCE,
      spec: "0-1",
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]!.source.startsWith("---\nformat:")).toBe(true);
    expect(parts[0]!.source).toContain("## One");

    const preambleSource = `Preamble text.\n\n# Title\n\nBody.\n\n## Sub\n\nMore.\n`;
    const { parts: preambleParts } = splitDocumentSource({
      source: preambleSource,
      spec: "each",
    });

    expect(preambleParts[0]!.source).toContain("Preamble text.");
    expect(preambleParts[1]!.source).not.toContain("Preamble text.");
  });

  it("keeps the preamble when the first section is excluded", () => {
    const source = `Preamble.\n\n# A\n\nAlpha.\n\n# B\n\nBeta.\n`;
    const { parts } = splitDocumentSource({ source, spec: "1" });

    expect(parts).toHaveLength(1);
    expect(parts[0]!.source).toContain("Preamble.");
    expect(parts[0]!.source).toContain("# B");
  });

  it("keeps 'all' as a single part", () => {
    const { parts } = splitDocumentSource({ source: SOURCE, spec: "all" });

    expect(parts).toHaveLength(1);
    expect(parts[0]!.sectionIndices).toEqual([0, 1, 2, 3]);
  });

  it("throws for a document without headings", () => {
    expect(() =>
      splitDocumentSource({ source: "Just a paragraph.", spec: "0" }),
    ).toThrow(/no Markdown headings/);
  });
});

describe("mergeDocumentSources", () => {
  it("concatenates sources in order, keeping only the first front-matter", () => {
    const merged = mergeDocumentSources({
      sources: [FRONT_MATTER_SOURCE, "# Second\n\nMore body.\n"],
    });

    // The first source's front-matter is kept exactly once.
    expect(merged.startsWith("---\nformat:")).toBe(true);
    expect(merged.match(/format:/g)?.length).toBe(1);
    expect(merged).toContain("# Title");
    expect(merged).toContain("More body.");
    expect(merged.endsWith("\n")).toBe(true);
  });

  it("strips later front-matter blocks", () => {
    const merged = mergeDocumentSources({
      sources: ["# A\n\nBody A.\n", FRONT_MATTER_SOURCE],
    });

    expect(merged.startsWith("# A")).toBe(true);
    expect(merged).not.toContain("format:");
    expect(merged.match(/# Title/g)?.length).toBe(1);
  });

  it("normalizes CRLF and trailing newlines", () => {
    const merged = mergeDocumentSources({
      sources: ["# A\r\n\r\nBody A.\r\n", "# B\r\n\r\nBody B.\r\n"],
    });

    expect(merged).toBe("# A\n\nBody A.\n\n# B\n\nBody B.\n");
  });

  it("throws when given no sources", () => {
    expect(() => mergeDocumentSources({ sources: [] })).toThrow(
      /At least one document/,
    );
  });
});
