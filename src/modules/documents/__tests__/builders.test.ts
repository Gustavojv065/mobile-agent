import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  buildDocument,
  ensureDocumentExtension,
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
});