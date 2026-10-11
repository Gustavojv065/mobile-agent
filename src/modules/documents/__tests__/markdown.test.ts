import { describe, expect, it } from "vitest";

import { parseInlineRuns, parseMarkdownBlocks } from "@/modules/documents/markdown";

describe("document markdown parser", () => {
  it("parses headings, paragraphs and page breaks", () => {
    const blocks = parseMarkdownBlocks("# Title\n\nHello world.\n\n---\n\n## Next");

    expect(blocks).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "paragraph", runs: [{ text: "Hello world." }] },
      { type: "pageBreak" },
      { type: "heading", level: 2, text: "Next" },
    ]);
  });

  it("parses bullet and numbered lists", () => {
    const blocks = parseMarkdownBlocks("- one\n- two\n- three\n\n1. first\n2. second");

    expect(blocks[0]).toEqual({
      type: "list",
      ordered: false,
      items: [
        [{ text: "one" }],
        [{ text: "two" }],
        [{ text: "three" }],
      ],
    });
    expect(blocks[1]).toEqual({
      type: "list",
      ordered: true,
      items: [[{ text: "first" }], [{ text: "second" }]],
    });
  });

  it("parses pipe tables", () => {
    const blocks = parseMarkdownBlocks(
      "| Name | Age |\n| --- | --- |\n| Ada | 36 |\n| Lin | 27 |",
    );

    expect(blocks).toEqual([
      {
        type: "table",
        headers: ["Name", "Age"],
        rows: [
          ["Ada", "36"],
          ["Lin", "27"],
        ],
      },
    ]);
  });

  it("parses fenced code blocks", () => {
    const blocks = parseMarkdownBlocks(
      "Before\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nAfter",
    );

    expect(blocks).toEqual([
      { type: "paragraph", runs: [{ text: "Before" }] },
      { type: "code", text: "const x = 1;\nconst y = 2;" },
      { type: "paragraph", runs: [{ text: "After" }] },
    ]);
  });

  it("splits inline bold, italic and code runs", () => {
    expect(parseInlineRuns("**bold** and *italic* and `code` and plain")).toEqual([
      { text: "bold", bold: true },
      { text: " and " },
      { text: "italic", italic: true },
      { text: " and " },
      { text: "code", code: true },
      { text: " and plain" },
    ]);
  });

  it("renders links as runs with an href", () => {
    expect(parseInlineRuns("See [docs](https://example.com) now")).toEqual([
      { text: "See " },
      { text: "docs", href: "https://example.com" },
      { text: " now" },
    ]);
  });

  it("parses standalone image blocks", () => {
    const blocks = parseMarkdownBlocks("![Logo](images/logo.png)");

    expect(blocks).toEqual([
      { type: "image", alt: "Logo", src: "images/logo.png" },
    ]);
  });

  it("parses image width from the optional title", () => {
    const blocks = parseMarkdownBlocks(
      '![Logo](logo.png "480")\n![Wide](w.png "640px")',
    );

    expect(blocks).toEqual([
      { type: "image", alt: "Logo", src: "logo.png", widthPx: 480 },
      { type: "image", alt: "Wide", src: "w.png", widthPx: 640 },
    ]);
  });

  it("keeps image lines out of paragraphs", () => {
    const blocks = parseMarkdownBlocks("Intro\n\n![A](a.png)\n\nOutro");

    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "image",
      "paragraph",
    ]);
  });
});