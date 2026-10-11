export type PdfPageRange = {
  /** 1-based inclusive page number. */
  end: number;
  /** 1-based inclusive page number. */
  start: number;
};

/**
 * Parse a page-range spec such as "1-3,5,7-9", "2", "1-", "-3" or "all" into
 * 1-based inclusive ranges validated against the pdf's page count.
 */
export function parsePdfPageRanges(
  spec: string,
  pageCount: number,
): PdfPageRange[] {
  const trimmed = spec.trim().toLowerCase();

  if (!trimmed) {
    throw new Error("The page ranges are required.");
  }

  if (pageCount < 1) {
    throw new Error("The pdf has no pages to split.");
  }

  if (trimmed === "all") {
    return [{ start: 1, end: pageCount }];
  }

  const ranges: PdfPageRange[] = [];

  for (const rawToken of trimmed.split(",")) {
    const token = rawToken.trim();

    if (!token) {
      throw new Error(`Invalid page range: "${rawToken}".`);
    }

    let start: number | null = null;
    let end: number | null = null;

    if (/^\d+$/.test(token)) {
      start = Number.parseInt(token, 10);
      end = start;
    } else if (/^\d+-\d+$/.test(token)) {
      const [startPart, endPart] = token.split("-");
      start = Number.parseInt(startPart ?? "", 10);
      end = Number.parseInt(endPart ?? "", 10);
    } else if (/^\d+-$/.test(token)) {
      start = Number.parseInt(token.slice(0, -1), 10);
      end = pageCount;
    } else if (/^-\d+$/.test(token)) {
      start = 1;
      end = Number.parseInt(token.slice(1), 10);
    } else {
      throw new Error(
        `Invalid page range: "${rawToken}". Use N, N-M, N-, -M or "all".`,
      );
    }

    if (start < 1 || end > pageCount || start > end) {
      throw new Error(
        `Page range "${token}" is outside the pdf (1-${pageCount}).`,
      );
    }

    ranges.push({ start, end });
  }

  return ranges;
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