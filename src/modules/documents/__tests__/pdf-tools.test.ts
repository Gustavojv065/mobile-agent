import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";

import { buildDocument } from "@/modules/documents";
import {
  mergePdfFiles,
  parsePdfPageRanges,
  splitPdfPages,
} from "@/modules/documents/pdf-tools";

const MULTI_PAGE = `# Page One

Content of the first page.

---

# Page Two

Content of the second page.

---

# Page Three

Content of the third page.
`;

async function buildMultiPagePdf() {
  const built = await buildDocument({
    format: "pdf",
    content: MULTI_PAGE,
    fileName: "report",
  });
  return built.bytes;
}

describe("parsePdfPageRanges", () => {
  it("parses single pages, ranges and lists", () => {
    expect(parsePdfPageRanges("1-3,5,7-9", 10)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5 },
      { start: 7, end: 9 },
    ]);
  });

  it("supports open-ended ranges and whitespace", () => {
    expect(parsePdfPageRanges("2-, -4", 10)).toEqual([
      { start: 2, end: 10 },
      { start: 1, end: 4 },
    ]);
  });

  it("supports 'all'", () => {
    expect(parsePdfPageRanges("all", 7)).toEqual([{ start: 1, end: 7 }]);
  });

  it("rejects ranges outside the page count", () => {
    expect(() => parsePdfPageRanges("1-11", 10)).toThrow(/outside/);
    expect(() => parsePdfPageRanges("0-2", 10)).toThrow(/outside/);
  });

  it("rejects reversed and malformed ranges", () => {
    expect(() => parsePdfPageRanges("9-2", 10)).toThrow(/outside/);
    expect(() => parsePdfPageRanges("banana", 10)).toThrow(/Invalid page range/);
    expect(() => parsePdfPageRanges("", 10)).toThrow(/required/);
  });
});

describe("splitPdfPages", () => {
  it("splits a pdf into the requested page ranges", async () => {
    const bytes = await buildMultiPagePdf();
    const { pageCount, parts } = await splitPdfPages({
      bytes,
      spec: "1-2,3",
    });

    expect(pageCount).toBe(3);
    expect(parts).toHaveLength(2);

    const first = await PDFDocument.load(parts[0]!, { ignoreEncryption: true });
    const second = await PDFDocument.load(parts[1]!, { ignoreEncryption: true });

    expect(first.getPageCount()).toBe(2);
    expect(second.getPageCount()).toBe(1);
  });

  it("supports 'all' to keep a single full copy", async () => {
    const bytes = await buildMultiPagePdf();
    const { parts } = await splitPdfPages({ bytes, spec: "all" });

    expect(parts).toHaveLength(1);

    const copy = await PDFDocument.load(parts[0]!, { ignoreEncryption: true });
    expect(copy.getPageCount()).toBe(3);
  });

  it("throws a readable error for invalid ranges", async () => {
    const bytes = await buildMultiPagePdf();

    await expect(
      splitPdfPages({ bytes, spec: "1-9" }),
    ).rejects.toThrow(/outside/);
  });
});

describe("mergePdfFiles", () => {
  it("merges pdfs in order", async () => {
    const bytesA = await buildMultiPagePdf();
    const builtB = await buildDocument({
      format: "pdf",
      content: "# Single\n\nOne page deck.",
      fileName: "single",
    });
    const { bytes, pageCount } = await mergePdfFiles({
      files: [bytesA, builtB.bytes],
    });

    expect(pageCount).toBe(4);

    const merged = await PDFDocument.load(bytes, { ignoreEncryption: true });
    expect(merged.getPageCount()).toBe(4);
  });

  it("requires at least one file", async () => {
    await expect(mergePdfFiles({ files: [] })).rejects.toThrow(/at least one/i);
  });
});