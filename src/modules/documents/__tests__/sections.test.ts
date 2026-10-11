import { describe, expect, it } from "vitest";

import {
  assembleDocumentSections,
  parseSectionContent,
  sectionPreview,
  splitDocumentSections,
} from "@/modules/documents/sections";

const REPORT_SOURCE = `# Progress Report

Quarterly summary of the team.

## Highlights

- Shipped the mobile agent

## Metrics

| Metric | Value |
| --- | --- |
| Releases | 12 |
`;

describe("splitDocumentSections", () => {
  it("splits every heading into its own section", () => {
    const split = splitDocumentSections(REPORT_SOURCE);

    expect(split.prefix).toBe("");
    expect(split.sections.map((section) => section.title)).toEqual([
      "Progress Report",
      "Highlights",
      "Metrics",
    ]);
    expect(split.sections.map((section) => section.level)).toEqual([1, 2, 2]);
    expect(split.sections[2]!.body).toBe(
      "## Metrics\n\n| Metric | Value |\n| --- | --- |\n| Releases | 12 |\n",
    );
  });

  it("keeps front-matter and preamble in the prefix", () => {
    const source = `---
format: docx
---

Intro line.

# Title

Body.
`;
    const split = splitDocumentSections(source);

    expect(split.prefix).toBe("---\nformat: docx\n---\n\nIntro line.\n\n");
    expect(split.sections).toHaveLength(1);
    expect(split.sections[0]!.body).toBe("# Title\n\nBody.\n");
  });

  it("ignores heading-like lines inside fenced code blocks", () => {
    const source = `# A

text

\`\`\`md
# not a heading
## also not
\`\`\`

## B

x
`;
    const split = splitDocumentSections(source);

    expect(split.sections.map((section) => section.title)).toEqual(["A", "B"]);
    expect(
      assembleDocumentSections(splitDocumentSections(source)),
    ).toBe(source);
  });

  it("returns no sections for heading-less content", () => {
    const split = splitDocumentSections("just some text\nwith lines\n");

    expect(split.sections).toEqual([]);
    expect(split.prefix).toBe("just some text\nwith lines\n");
  });

  it("round-trips arbitrarily shaped markdown losslessly", () => {
    const samples = [
      REPORT_SOURCE,
      "",
      "# Only heading",
      "no headings here\njust text\n",
      "intro line\n\n# A\nline\n## A.1\nx",
      "---\nformat: pdf\n---\n\n# T\n\n## S\n\nbody",
    ];

    for (const sample of samples) {
      const roundTripped = assembleDocumentSections(
        splitDocumentSections(sample),
      );
      expect(roundTripped).toBe(sample.replace(/\r\n?/g, "\n"));
    }
  });
});

describe("parseSectionContent", () => {
  it("requires a leading Markdown heading", () => {
    expect(() => parseSectionContent("no heading here")).toThrow(
      /must start with a Markdown heading/,
    );
  });

  it("extracts the title and level and drops trailing blank lines", () => {
    expect(parseSectionContent("## New Section\n\nbody\n\n")).toEqual({
      title: "New Section",
      level: 2,
      body: "## New Section\n\nbody",
    });
  });
});

describe("sectionPreview", () => {
  it("flattens the prose under the heading", () => {
    expect(sectionPreview("## H\n\nHello   world\nmore")).toBe(
      "Hello world more",
    );
  });

  it("truncates long previews", () => {
    const preview = sectionPreview(`## H\n\n${"a".repeat(200)}`, 20);
    expect(preview).toBe(`${"a".repeat(20)}…`);
  });
});
