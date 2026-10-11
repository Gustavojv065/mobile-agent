import { describe, expect, it } from "vitest";

import {
  buildDocument,
  extractDocument,
  getDocumentFormat,
  getDocumentFormatFromMimeType,
} from "@/modules/documents";

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

\`\`\`js
const planets = 8;
\`\`\`

---

## Conclusion

We are small.
`;

describe("document extraction", () => {
  it("resolves formats from file names and mime types", () => {
    expect(getDocumentFormat("a.docx")).toBe("docx");
    expect(getDocumentFormat("b.pdf")).toBe("pdf");
    expect(getDocumentFormatFromMimeType("application/pdf")).toBe("pdf");
    expect(
      getDocumentFormatFromMimeType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("xlsx");
    expect(getDocumentFormatFromMimeType("text/plain")).toBeNull();
    expect(getDocumentFormatFromMimeType(null)).toBeNull();
  });

  it("extracts docx text with headings, lists and tables", async () => {
    const built = await buildDocument({
      format: "docx",
      content: SAMPLE,
      fileName: "solar-system",
    });
    const extracted = await extractDocument("docx", built.bytes);

    expect(extracted.format).toBe("docx");
    expect(extracted.text).toContain("# The Solar System");
    expect(extracted.text).toContain("## The Sun");
    expect(extracted.text).toContain(
      "An essay about our neighborhood in space.",
    );
    expect(extracted.text).toContain("- Mercury");
    expect(extracted.text).toContain("- Venus");
    expect(extracted.text).toContain("## The Planets");
    expect(extracted.text).toContain("| Planet | Type | Moons |");
    expect(extracted.text).toContain("| Mars | Rocky | 2 |");
    expect(extracted.text).toContain("const planets = 8;");
    expect(extracted.text).toContain("We are small.");
  });

  it("extracts xlsx text with sheet names and rows", async () => {
    const built = await buildDocument({
      format: "xlsx",
      content: SAMPLE,
      fileName: "planets",
    });
    const extracted = await extractDocument("xlsx", built.bytes);

    expect(extracted.format).toBe("xlsx");
    expect(extracted.sheetNames).toContain("planets");
    expect(extracted.text).toContain("## Sheet: planets");
    expect(extracted.text).toContain("Planet,Type,Moons");
    expect(extracted.text).toContain("Jupiter,Gas giant,95");
    expect(extracted.text).toContain("## Sheet: Notes");
  });

  it("extracts pptx text with slide headers and body content", async () => {
    const built = await buildDocument({
      format: "pptx",
      content: SAMPLE,
      fileName: "solar-system",
    });
    const extracted = await extractDocument("pptx", built.bytes);

    expect(extracted.format).toBe("pptx");
    expect(extracted.slideCount).toBeGreaterThanOrEqual(5);
    expect(extracted.text).toContain("## Slide 1");
    expect(extracted.text).toContain("The Solar System");
    expect(extracted.text).toContain("Mercury");
    expect(extracted.text).toContain("Venus");
    expect(extracted.text).toContain("Conclusion");
  });

  it("extracts pdf text with the page count", async () => {
    const built = await buildDocument({
      format: "pdf",
      content: SAMPLE,
      fileName: "solar-system",
    });
    const extracted = await extractDocument("pdf", built.bytes);

    expect(extracted.format).toBe("pdf");
    expect(extracted.pageCount).toBeGreaterThanOrEqual(2);
    expect(extracted.text).toContain("The Solar System");
    expect(extracted.text).toContain("The Sun is a star at the center of the system.");
    expect(extracted.text).toContain("We are small.");
  });

  it("throws a readable error for corrupt archives", async () => {
    await expect(
      extractDocument("docx", new Uint8Array([1, 2, 3, 4, 5])),
    ).rejects.toThrow(/Invalid docx/);
    await expect(
      extractDocument("xlsx", new Uint8Array([1, 2, 3, 4, 5])),
    ).rejects.toThrow(/Invalid xlsx/);
  });
});