import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { buildDocument, extractDocument } from "@/modules/documents";

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SAMPLE = `# The Solar System

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

---

## Conclusion

We are small.
`;

describe("pdf builder", () => {
  it("builds an A4 document with the file name as title", async () => {
    const built = await buildDocument({
      format: "pdf",
      content: SAMPLE,
      fileName: "solar-system",
    });

    expect(built.format).toBe("pdf");
    expect(built.fileName).toBe("solar-system.pdf");
    expect(new TextDecoder().decode(built.bytes.subarray(0, 4))).toBe("%PDF");

    const pdf = await PDFDocument.load(built.bytes);

    expect(pdf.getPageCount()).toBeGreaterThan(0);
    expect(pdf.getTitle()).toBe("solar-system.pdf");

    const { width, height } = pdf.getPage(0).getSize();

    expect(width).toBeCloseTo(595.28, 1);
    expect(height).toBeCloseTo(841.89, 1);
  });

  it("applies a full front-matter spec including header and footer", async () => {
    const STYLED = `---
format:
  page:
    size: LETTER
    orientation: landscape
    marginLeftPt: 40
  fonts:
    body:
      family: Georgia
      sizePt: 12
      color: "#222222"
  paragraphs:
    lineSpacing: 1.5
  header:
    text: "Confidential"
  footer:
    text: "Page {PAGE}"
  pageNumberPosition: right
---

# The Solar System

An essay about our neighborhood in space.

Another paragraph that pushes content onto a second page.
`;

    const built = await buildDocument({
      format: "pdf",
      content: STYLED,
      fileName: "styled-pdf",
    });

    const pdf = await PDFDocument.load(built.bytes);
    const { width, height } = pdf.getPage(0).getSize();

    // LETTER landscape = 792 x 612.
    expect(width).toBeCloseTo(792, 1);
    expect(height).toBeCloseTo(612, 1);

    const extracted = await extractDocument("pdf", built.bytes);

    expect(extracted.text).toContain("The Solar System");
    expect(extracted.text).toContain("Confidential");
    expect(extracted.text).toContain("Page 1");
  });

  it("embeds a data-URI PNG image", async () => {
    const WITH_IMAGE = `# The Solar System

![Tiny](data:image/png;base64,${ONE_PX_PNG})

We are small.
`;

    const built = await buildDocument({
      format: "pdf",
      content: WITH_IMAGE,
      fileName: "with-image",
    });

    const pdf = await PDFDocument.load(built.bytes);

    expect(pdf.getPageCount()).toBeGreaterThan(0);
  });

  it("rejects unsupported image formats with a clear error", async () => {
    const WITH_GIF = `# Title

![Gif](data:image/gif;base64,R0lGODlhAQABAAAAACw=)
`;

    await expect(
      buildDocument({ format: "pdf", content: WITH_GIF, fileName: "with-gif" }),
    ).rejects.toThrow(/only PNG and JPEG/i);
  });
});