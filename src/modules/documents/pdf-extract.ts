import { ensurePdfGlobals } from "@/modules/documents/pdf-shims";

export type ExtractedPdf = {
  pageCount: number;
  pages: string[];
  text: string;
};

/**
 * Extract text from a PDF using the serverless pdf.js build bundled with
 * unpdf. The pdf.js module is imported lazily (it is ~1.6 MB) and only when a
 * PDF is actually read, so app startup is unaffected. Guarded shims for a few
 * browser globals pdf.js touches are installed first so it also works on
 * Hermes runtimes that lack them.
 */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPdf> {
  ensurePdfGlobals();

  const { extractText } = await import("unpdf");
  const result = await extractText(bytes, {
    mergePages: false,
  });

  const pages = result.text.map((page) => String(page ?? ""));

  return {
    pageCount: result.totalPages,
    pages,
    text: pages.join("\n\n"),
  };
}