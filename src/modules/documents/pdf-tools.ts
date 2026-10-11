import { parseIndexRanges, type IndexRange } from "@/modules/documents/ranges";

export type PdfPageRange = IndexRange;

/**
 * Parse a page-range spec such as "1-3,5,7-9", "2", "1-", "-3" or "all" into
 * 1-based inclusive ranges validated against the pdf's page count.
 */
export function parsePdfPageRanges(
  spec: string,
  pageCount: number,
): PdfPageRange[] {
  return parseIndexRanges(spec, pageCount, "page");
}

function pageIndices(range: PdfPageRange): number[] {
  const indices: number[] = [];

  for (let page = range.start; page <= range.end; page += 1) {
    indices.push(page - 1);
  }

  return indices;
}

/**
 * Split a pdf into parts by page ranges. Every range becomes its own pdf
 * document; the page ranges are taken in the order given, so overlapping or
 * duplicated ranges produce overlapping parts.
 */
export async function splitPdfPages(input: {
  bytes: Uint8Array;
  spec: string;
}): Promise<{ pageCount: number; parts: Uint8Array[] }> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(input.bytes, {
    ignoreEncryption: true,
  });
  const pageCount = source.getPageCount();
  const ranges = parsePdfPageRanges(input.spec, pageCount);
  const parts: Uint8Array[] = [];

  for (const range of ranges) {
    const destination = await PDFDocument.create();
    const copied = await destination.copyPages(source, pageIndices(range));
    copied.forEach((page) => destination.addPage(page));
    parts.push(await destination.save());
  }

  return { pageCount, parts };
}

/**
 * Merge several pdf files into one document, preserving the order of the
 * inputs. Pages are copied, so every input keeps its content and layout.
 */
export async function mergePdfFiles(input: {
  files: Uint8Array[];
}): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const { PDFDocument } = await import("pdf-lib");

  if (input.files.length === 0) {
    throw new Error("At least one pdf file is required to merge.");
  }

  const destination = await PDFDocument.create();
  let pageCount = 0;

  for (const bytes of input.files) {
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const count = source.getPageCount();
    const copied = await destination.copyPages(
      source,
      Array.from({ length: count }, (_, index) => index),
    );
    copied.forEach((page) => destination.addPage(page));
    pageCount += count;
  }

  return { bytes: await destination.save(), pageCount };
}