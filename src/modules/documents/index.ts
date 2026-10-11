import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_FORMATS,
  DOCUMENT_MIME_TYPES,
  isDocumentFormat,
  type BuildDocumentInput,
  type BuiltDocument,
  type DocumentFormat,
} from "@/modules/documents/types";

export * from "@/modules/documents/types";

export {
  extractDocument,
  extractDocx,
  extractPptx,
  extractXlsx,
} from "@/modules/documents/extract";
export type { ExtractedDocument } from "@/modules/documents/extract";

export function getDocumentFormat(fileName: string): DocumentFormat | null {
  if (!fileName) {
    return null;
  }

  const lowerName = fileName.toLowerCase();

  for (const format of DOCUMENT_FORMATS) {
    if (lowerName.endsWith(DOCUMENT_EXTENSIONS[format])) {
      return format;
    }
  }

  return null;
}

export function getDocumentFormatFromMimeType(
  mimeType: string | null | undefined,
): DocumentFormat | null {
  if (!mimeType) {
    return null;
  }

  const lowerMime = mimeType.toLowerCase();

  for (const format of DOCUMENT_FORMATS) {
    if (DOCUMENT_MIME_TYPES[format] === lowerMime) {
      return format;
    }
  }

  return null;
}

/**
 * Detect whether a workspace file (name and/or mime type) is one of the
 * supported binary document formats. Pure helper with no runtime imports, so
 * it is safe to use anywhere including tests.
 */
export function isDocumentFile(input: {
  displayName: string;
  mimeType?: string | null;
}): boolean {
  if (getDocumentFormat(input.displayName)) {
    return true;
  }

  const mimeType = input.mimeType?.toLowerCase() ?? "";
  return (
    mimeType.length > 0 && getDocumentFormatFromMimeType(mimeType) !== null
  );
}

export function isDocumentFileName(fileName: string): boolean {
  return getDocumentFormat(fileName) !== null;
}

export function ensureDocumentExtension(
  fileName: string,
  format: DocumentFormat,
): string {
  const extension = DOCUMENT_EXTENSIONS[format];
  return fileName.toLowerCase().endsWith(extension)
    ? fileName
    : `${fileName}${extension}`;
}

/**
 * Build a binary document (docx, pdf, pptx, xlsx) from Markdown/plain-text
 * content. Format-specific builders are imported lazily so only the requested
 * library is evaluated.
 */
export async function buildDocument(
  input: BuildDocumentInput,
): Promise<BuiltDocument> {
  if (!isDocumentFormat(input.format)) {
    throw new Error(`Unsupported document format: ${String(input.format)}`);
  }

  const baseName = input.fileName?.trim() || "document";
  const fileName = ensureDocumentExtension(baseName, input.format);
  const content = input.content ?? "";

  let bytes: Uint8Array;

  switch (input.format) {
    case "docx":
      bytes = await (await import("@/modules/documents/docx")).buildDocx({
        content,
        fileName,
      });
      break;
    case "pdf":
      bytes = await (await import("@/modules/documents/pdf")).buildPdf({
        content,
        fileName,
      });
      break;
    case "pptx":
      bytes = await (await import("@/modules/documents/pptx")).buildPptx({
        content,
        fileName,
      });
      break;
    case "xlsx":
      bytes = await (await import("@/modules/documents/xlsx")).buildXlsx({
        content,
        fileName,
      });
      break;
    default:
      throw new Error(`Unsupported document format: ${String(input.format)}`);
  }

  return {
    bytes,
    fileName,
    format: input.format,
    mimeType: DOCUMENT_MIME_TYPES[input.format],
  };
}
