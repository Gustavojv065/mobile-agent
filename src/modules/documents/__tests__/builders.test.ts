import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  buildDocument,
  ensureDocumentExtension,
  extractDocument,
  getDocumentFormat,
  isDocumentFileName,
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

async function unzip(bytes: Uint8Array) {
  return JSZip.loadAsync(bytes);
}

describe("document builders", () => {
  it("appends the matching extension to file names", () => {
    expect(ensureDocumentExtension("essay", "docx")).toBe("essay.docx");
    expect(ensureDocumentExtension("essay.docx", "docx")).toBe("essay.docx");
    expect(ensureDocumentExtension("slides", "pptx")).toBe("slides.pptx");
    expect(ensureDocumentExtension("data", "xlsx")).toBe("data.xlsx");
    expect(ensureDocumentExtension("report", "pdf")).toBe("report.pdf");
  });

  it("detects document formats from file names", () => {
    expect(getDocumentFormat("a.DOCX")).toBe("docx");
    expect(getDocumentFormat("b.xlsx")).toBe("xlsx");
    expect(getDocumentFormat("c.pptx")).toBe("pptx");
    expect(getDocumentFormat("d.pdf")).toBe("pdf");
    expect(getDocumentFormat("plain.txt")).toBeNull();
    expect(isDocumentFileName("notes.docx")).toBe(true);
    expect(isDocumentFileName("notes.txt")).toBe(false);
  });

  it("builds a docx that unzips to a valid Word document", async () => {
    const built = await buildDocument({
      format: "docx",
      content: SAMPLE,
      fileName: "solar-system",
    });

    expect(built.format).toBe("docx");
    expect(built.fileName).toBe("solar-system.docx");
    expect(built.mimeType).toContain("wordprocessingml");
    expect(new TextDecoder().decode(built.bytes.subarray(0, 2))).toBe("PK");

    const zip = await unzip(built.bytes);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    expect(documentXml).toBeDefined();
    expect(documentXml).toContain("The Solar System");
    expect(documentXml).toContain("Mars");
  });

  it("builds a pdf that pdf-lib can load", async () => {
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
  });

  it("builds a pptx that unzips to a valid presentation", async () => {
    const built = await buildDocument({
      format: "pptx",
      content: SAMPLE,
      fileName: "solar-system",
    });

    expect(built.format).toBe("pptx");
    expect(built.fileName).toBe("solar-system.pptx");
    expect(new TextDecoder().decode(built.bytes.subarray(0, 2))).toBe("PK");

    const zip = await unzip(built.bytes);
    const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
    expect(presentationXml).toBeDefined();
    const slideCount = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    ).length;
    expect(slideCount).toBeGreaterThanOrEqual(3);
  });

  it("builds an xlsx that SheetJS can read back", async () => {
    const built = await buildDocument({
      format: "xlsx",
      content: SAMPLE,
      fileName: "planets",
    });

    expect(built.format).toBe("xlsx");
    expect(built.fileName).toBe("planets.xlsx");
    expect(new TextDecoder().decode(built.bytes.subarray(0, 2))).toBe("PK");

    const workbook = XLSX.read(built.bytes, { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]!];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }) as unknown[][];

    expect(rows[0]).toContain("Planet");
    expect(rows.some((row) => row.includes("Jupiter"))).toBe(true);
  });

  it("parses raw CSV content into a spreadsheet", async () => {
    const built = await buildDocument({
      format: "xlsx",
      content: "name,score\nAda,10\nLin,9",
      fileName: "scores",
    });

    const workbook = XLSX.read(built.bytes, { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]!];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }) as unknown[][];

    expect(rows[0]).toEqual(["name", "score"]);
    expect(rows[1]).toEqual(["Ada", 10]);
  });

  it("passes through bytes for all formats without throwing on unicode", async () => {
    const content = "# Café résumé\n\nEmoji are replaced: 😀 and smart quotes are “quoted”.";

    for (const format of ["docx", "pdf", "pptx", "xlsx"] as const) {
      const built = await buildDocument({ format, content, fileName: "u" });
      expect(built.bytes.byteLength).toBeGreaterThan(10);
    }
  });

  it("strips front-matter from every format body", async () => {
    const content =
      "---\nformat:\n  page:\n    size: A5\n---\n\n# The Solar System\n\nBody text.";

    for (const format of ["docx", "pptx", "xlsx"] as const) {
      const built = await buildDocument({ format, content, fileName: "fm" });

      if (format === "xlsx") {
        const workbook = XLSX.read(built.bytes, { type: "array" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]!];
        const csv = XLSX.utils.sheet_to_csv(firstSheet);
        expect(csv).toContain("The Solar System");
        expect(csv).not.toContain("page:");
        continue;
      }

      const zip = await unzip(built.bytes);
      const mainFile = Object.keys(zip.files).find((name) =>
        /\/document\.xml$/.test(name) || /slides\/slide1\.xml$/.test(name),
      );
      const xml = await zip.file(mainFile!)?.async("string");
      expect(xml).toContain("The Solar System");
      expect(xml ?? "").not.toContain("page:");
    }

    const pdfBuilt = await buildDocument({
      format: "pdf",
      content,
      fileName: "fm",
    });
    const extracted = await extractDocument("pdf", pdfBuilt.bytes);
    expect(extracted.text).toContain("The Solar System");
    expect(extracted.text).not.toContain("page:");
  });
});

describe("docx spec-driven builder", () => {
  const ONE_PX_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const STYLED = `---
format:
  page:
    size: LETTER
  fonts:
    body:
      family: Georgia
      sizePt: 12
  header:
    text: "Confidential"
  footer:
    text: "Page {PAGE}"
  includeToc: true
---

# The Solar System

An essay about our neighborhood in space.
`;

  it("applies a front-matter spec to the docx output", async () => {
    const built = await buildDocument({
      format: "docx",
      content: STYLED,
      fileName: "styled",
    });

    const zip = await unzip(built.bytes);

    const documentXml = await zip.file("word/document.xml")?.async("string");
    expect(documentXml).toContain("The Solar System");
    expect(documentXml).toContain("TOC");
    expect(documentXml).toContain('w:pgSz w:w="12240"');

    const headerXml = await zip.file("word/header1.xml")?.async("string");
    expect(headerXml).toContain("Confidential");

    const footerXml = await zip.file("word/footer1.xml")?.async("string");
    expect(footerXml).toContain("Page");
    expect(footerXml).toContain("PAGE");

    const stylesXml = await zip.file("word/styles.xml")?.async("string");
    expect(stylesXml).toContain("Georgia");
    expect(stylesXml).toContain('w:sz w:val="24"');
  });

  it("lets the spec parameter override front-matter values", async () => {
    const built = await buildDocument({
      format: "docx",
      content: STYLED,
      fileName: "styled",
      spec: { fonts: { body: { family: "Arial" } }, page: { size: "A5" } },
    });

    const zip = await unzip(built.bytes);
    const stylesXml = await zip.file("word/styles.xml")?.async("string");
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(stylesXml).toContain("Arial");
    expect(stylesXml).not.toContain("Georgia");
    expect(documentXml).toContain('w:pgSz w:w="8391"');
  });

  it("sets an explicit document title from the spec", async () => {
    const built = await buildDocument({
      format: "docx",
      content: "---\nformat:\n  title: My Custom Title\n---\n\n# Body",
      fileName: "styled",
    });

    const zip = await unzip(built.bytes);
    const coreXml = await zip.file("docProps/core.xml")?.async("string");
    expect(coreXml).toContain("My Custom Title");
  });

  it("embeds images from data URIs and from the image resolver", async () => {
    const content = `# Logo page

![Tiny](data:image/png;base64,${ONE_PX_PNG})

![Workspace](images/tiny.png)
`;
    const built = await buildDocument({
      format: "docx",
      content,
      fileName: "images",
      resolveImage: async (src) =>
        src === "images/tiny.png"
          ? Uint8Array.from(atob(ONE_PX_PNG), (char) => char.charCodeAt(0))
          : new Uint8Array(0),
    });

    const zip = await unzip(built.bytes);

    expect(zip.file("word/media/image1.png")).toBeDefined();
    expect(zip.file("word/media/image2.png")).toBeDefined();

    const documentXml = await zip.file("word/document.xml")?.async("string");
    expect(documentXml).toContain("r:embed");
  });

  it("applies an explicit image width", async () => {
    const content = `# Logo page

![Sized](data:image/png;base64,${ONE_PX_PNG} "100")
`;
    const built = await buildDocument({
      format: "docx",
      content,
      fileName: "sized",
    });

    const zip = await unzip(built.bytes);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    // 100 px * 9525 EMU per px = 952500.
    expect(documentXml).toContain('cx="952500"');
    expect(documentXml).toContain('cy="952500"');
  });

  it("rejects invalid specs with a clear error", async () => {
    await expect(
      buildDocument({
        format: "docx",
        content: "# Hi",
        fileName: "bad",
        spec: { page: { size: "NOPE" } },
      }),
    ).rejects.toThrow(/Invalid docx spec/);
  });

  it("applies a base spec below front-matter and parameters", async () => {
    const content =
      "---\nformat:\n  fonts:\n    body:\n      family: Times New Roman\n---\n\n# Body";

    const built = await buildDocument({
      format: "docx",
      content,
      fileName: "precedence",
      baseSpec: {
        fonts: { body: { family: "Georgia" } },
        page: { size: "A5" },
      },
    });

    const zip = await unzip(built.bytes);
    const stylesXml = await zip.file("word/styles.xml")?.async("string");
    const documentXml = await zip.file("word/document.xml")?.async("string");

    // Front-matter beats the stored snapshot, which still supplies its other keys.
    expect(stylesXml).toContain("Times New Roman");
    expect(stylesXml).not.toContain("Georgia");
    expect(documentXml).toContain('w:pgSz w:w="8391"');
  });

  it("lets the spec parameter beat the base spec", async () => {
    const built = await buildDocument({
      format: "docx",
      content: "# Body",
      fileName: "base",
      baseSpec: { fonts: { body: { family: "Georgia" } } },
      spec: { fonts: { body: { family: "Verdana" } } },
    });

    const zip = await unzip(built.bytes);
    const stylesXml = await zip.file("word/styles.xml")?.async("string");

    expect(stylesXml).toContain("Verdana");
    expect(stylesXml).not.toContain("Georgia");
  });
});