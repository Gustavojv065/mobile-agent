import { describe, expect, it } from "vitest";

import {
  buildDocument,
  extractDocument,
  type ExtractedDocument,
} from "@/modules/documents";
import {
  buildDocumentPreviewHtml,
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
});