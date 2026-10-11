import { describe, expect, it } from "vitest";

import {
  buildDocument,
  extractDocument,
  type ExtractedDocument,
} from "@/modules/documents";
import {
  buildDocumentPreviewHtml,
  renderInlineMarkdown,
  renderMarkdownishText,
} from "@/modules/preview/document-preview";

const SAMPLE_MARKDOWN = `# The Solar System

An essay about our neighborhood in space.

## The Sun

The Sun is a star at the center of the system.

- Mercury
- Venus
- Earth

## The Planets

| Planet | Type | Moons |
| --- | --- | --- |
| Mars | Rocky | 2 |
| Jupiter | Gas giant | 95 |

\`\`\`js
const planets = 8;
\`\`\`

---

## Conclusion

We are small.
`;

async function extractSample(format: "docx" | "pdf" | "pptx" | "xlsx") {
  const built = await buildDocument({
    format,
    content: SAMPLE_MARKDOWN,
    fileName: "solar-system",
  });
  return extractDocument(format, built.bytes);
}

describe("renderMarkdownishText", () => {
  it("renders headings, lists, paragraphs and code", () => {
    const html = renderMarkdownishText(
      "# Title\n\nSome words.\n\n- one\n- two\n\n1. first\n2. second",
    );

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Some words.</p>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("renders pipe tables with a header row and escapes cell text", () => {
    const html = renderMarkdownishText(
      "| A | B |\n| --- | --- |\n| 1 | <x> |",
    );

    expect(html).toContain("<table>");
    expect(html).toContain("<thead><tr><th>A</th><th>B</th></tr></thead>");
    expect(html).toContain("<td>1</td><td>&lt;x&gt;</td>");
  });
});

describe("buildDocumentPreviewHtml", () => {
  it("renders docx extraction as a document with tables and lists", async () => {
    const extracted = await extractSample("docx");
    const html = buildDocumentPreviewHtml({ extracted, title: "essay.docx" });

    expect(html).toContain("<title>essay.docx</title>");
    expect(html).toContain('<article class="document">');
    expect(html).toContain("<h1>The Solar System</h1>");
    expect(html).toContain("<li>Mercury</li>");
    expect(html).toContain("<th>Planet</th>");
    expect(html).toContain("<td>Jupiter</td>");
  });

  it("renders pdf extraction page by page", async () => {
    const extracted = await extractSample("pdf");
    const html = buildDocumentPreviewHtml({ extracted, title: "essay.pdf" });

    expect(extracted.pageCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<div class="page-label">Page 1</div>');
    expect(html).toContain('<div class="stack">');
  });

  it("renders pptx extraction as slide cards", async () => {
    const extracted = await extractSample("pptx");
    const html = buildDocumentPreviewHtml({ extracted, title: "slides.pptx" });

    expect(html).toContain('<div class="slide-number">Slide 1</div>');
    expect(html).toContain("The Solar System");
  });

  it("renders xlsx extraction as per-sheet tables", async () => {
    const extracted = await extractSample("xlsx");
    const html = buildDocumentPreviewHtml({ extracted, title: "planets.xlsx" });

    expect(extracted.sheets?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(html).toContain('<section class="sheet">');
    expect(html).toContain("<th>Planet</th>");
    expect(html).toContain("<td>Jupiter</td>");
  });

  it("escapes document titles in the document head", () => {
    const extracted = {
      format: "pdf",
      text: "hello",
      pages: ["hello"],
    } as ExtractedDocument;
    const html = buildDocumentPreviewHtml({
      extracted,
      title: "a<b>&c.pdf",
    });

    expect(html).toContain("<title>a&lt;b&gt;&amp;c.pdf</title>");
  });

  it("falls back to the document text when a workbook has no sheet grid", () => {
    const extracted = {
      format: "xlsx",
      text: "# Sheetless\n\nJust words.",
    } as ExtractedDocument;
    const html = buildDocumentPreviewHtml({ extracted, title: "plain.xlsx" });

    expect(html).toContain("<h1>Sheetless</h1>");
    expect(html).toContain("<p>Just words.</p>");
  });

  it("shows the empty message when nothing readable was extracted", () => {
    const extracted = {
      format: "docx",
      text: "",
    } as ExtractedDocument;
    const html = buildDocumentPreviewHtml({ extracted, title: "empty.docx" });

    expect(html).toContain("No readable text in this preview.");
  });
});

describe("renderInlineMarkdown", () => {
  it("renders bold, italic and inline code", () => {
    expect(renderInlineMarkdown("a **bold** word")).toContain(
      "<strong>bold</strong>",
    );
    expect(renderInlineMarkdown("a *soft* word")).toContain("<em>soft</em>");
    expect(renderInlineMarkdown("run `code()` now")).toContain(
      "<code>code()</code>",
    );
  });

  it("does not format markers inside inline code", () => {
    expect(renderInlineMarkdown("`**not bold**`")).toBe(
      "<code>**not bold**</code>",
    );
  });

  it("links safe schemes and leaves markup escaped", () => {
    const html = renderInlineMarkdown(
      "see [docs](https://example.com/a?b=1&c=2) and <script>alert(1)</script>",
    );

    expect(html).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noreferrer">docs</a>',
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("refuses to link unsafe schemes", () => {
    const html = renderInlineMarkdown("[x](javascript:alert(1))");

    expect(html).not.toContain("<a ");
    expect(html).toContain("[x](javascript:alert(1))");
  });
});

describe("renderMarkdownishText hardening", () => {
  it("renders blockquotes and heading inline formatting", () => {
    const html = renderMarkdownishText(
      "# A **bold** title\n\n> quoted *words*\n> second line",
    );

    expect(html).toContain("<h1>A <strong>bold</strong> title</h1>");
    expect(html).toContain(
      "<blockquote><p>quoted <em>words</em></p><p>second line</p></blockquote>",
    );
  });

  it("keeps the fenced code language on the block", () => {
    const html = renderMarkdownishText("```js\nconst a = 1;\n```");

    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain("const a = 1;");
    expect(html).toContain("</code></pre>");
  });

  it("applies inline formatting inside list items and table cells", () => {
    const html = renderMarkdownishText(
      "- a **bold** item\n\n| H |\n| --- |\n| `v` |",
    );

    expect(html).toContain("<li>a <strong>bold</strong> item</li>");
    expect(html).toContain("<td><code>v</code></td>");
  });
});

describe("buildDocumentPreviewHtml truncation", () => {
  it("caps very long docx text and shows a truncation note", () => {
    const extracted = {
      format: "docx",
      text: `${"# Big\n\n"}${"word ".repeat(60_000)}`,
    } as ExtractedDocument;
    const html = buildDocumentPreviewHtml({ extracted, title: "big.docx" });

    expect(html).toContain("Preview truncated");
    expect(html.length).toBeLessThan(300_000);
  });

  it("caps pdf pages and sheet grids", () => {
    const pdf = {
      format: "pdf",
      text: "all",
      pages: Array.from({ length: 500 }, (_v, i) => `page ${i}`),
    } as ExtractedDocument;
    const pdfHtml = buildDocumentPreviewHtml({ extracted: pdf, title: "p.pdf" });

    expect(pdfHtml).not.toContain("page 499");
    expect(pdfHtml).toContain("Preview truncated");

    const xlsx = {
      format: "xlsx",
      text: "",
      sheets: [
        {
          name: "Big",
          rows: Array.from({ length: 1_000 }, () =>
            Array.from({ length: 60 }, (_v, i) => `c${i}`),
          ),
        },
      ],
    } as ExtractedDocument;
    const xlsxHtml = buildDocumentPreviewHtml({
      extracted: xlsx,
      title: "b.xlsx",
    });

    expect(xlsxHtml).toContain("Preview truncated");
    expect(xlsxHtml).not.toContain("c59");
    expect(xlsxHtml).toContain("<td>c0</td>");
  });

  it("does not show the note for small documents", () => {
    const extracted = {
      format: "docx",
      text: "# Small\n\nFine.",
    } as ExtractedDocument;
    const html = buildDocumentPreviewHtml({ extracted, title: "s.docx" });

    expect(html).not.toContain("Preview truncated");
  });
});