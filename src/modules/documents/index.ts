import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_FORMATS,
  DOCUMENT_MIME_TYPES,
  isDocumentFormat,
  type BuildDocumentInput,
  type BuiltDocument,
  type DocumentFormat,
} from "@/modules/documents/types";

import { parseDocumentSource } from "@/modules/documents/source";
import { parseDocxSpec } from "@/modules/documents/spec/docx-spec";
import { parsePdfSpec } from "@/modules/documents/spec/pdf-spec";
import { parseXlsxSpec } from "@/modules/documents/spec/xlsx-spec";
import { parsePptxSpec } from "@/modules/documents/spec/pptx-spec";
import { deepMerge } from "@/modules/documents/spec/merge";

export * from "@/modules/documents/types";

export {
  extractDocument,
  extractDocx,
  extractPptx,
  extractXlsx,
} from "@/modules/documents/extract";
export type { ExtractedDocument } from "@/modules/documents/extract";

export {
  parseDocumentSource,
  mergeSpecIntoSource,
} from "@/modules/documents/source";
export type { DocumentSource } from "@/modules/documents/source";

export {
  splitDocumentSource,
  mergeDocumentSources,
} from "@/modules/documents/split-merge";
export type { DocumentPart } from "@/modules/documents/split-merge";

export {
  splitPptxSlides,
  splitXlsxSheets,
} from "@/modules/documents/ooxml-split";
export type { OoxmlSplitResult } from "@/modules/documents/ooxml-split";

export {
  parseDocxSpec,
  defaultDocxSpec,
  docxSpecSchema,
} from "@/modules/documents/spec/docx-spec";
export type { DocxSpec } from "@/modules/documents/spec/docx-spec";

export {
  parseXlsxSpec,
  defaultXlsxSpec,
  xlsxSpecSchema,
} from "@/modules/documents/spec/xlsx-spec";
export type { XlsxSpec } from "@/modules/documents/spec/xlsx-spec";

export {
  parsePptxSpec,
  defaultPptxSpec,
  pptxSpecSchema,
} from "@/modules/documents/spec/pptx-spec";
export type { PptxSpec } from "@/modules/documents/spec/pptx-spec";
export { snapshotPptxSpec } from "@/modules/documents/snapshot/pptx-snapshot";
export {
  parsePdfSpec,
  defaultPdfSpec,
  pdfSpecSchema,
} from "@/modules/documents/spec/pdf-spec";
export type { PdfSpec } from "@/modules/documents/spec/pdf-spec";

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
 * content. A YAML front-matter block (if present) is split off and its
 * `format:` key feeds the format spec; for docx the optional `spec` input is
 * merged on top of the front-matter spec (parameter wins). Format-specific
 * builders are imported lazily so only the requested library is evaluated.
 */
export async function buildDocument(
  input: BuildDocumentInput,
): Promise<BuiltDocument> {
  if (!isDocumentFormat(input.format)) {
    throw new Error(`Unsupported document format: ${String(input.format)}`);
  }

  const baseName = input.fileName?.trim() || "document";
  const fileName = ensureDocumentExtension(baseName, input.format);
  const { body, meta } = parseDocumentSource(input.content ?? "");
  const frontMatterSpec =
    meta.format !== null &&
    typeof meta.format === "object" &&
    !Array.isArray(meta.format)
      ? meta.format
      : {};

  let bytes: Uint8Array;

  switch (input.format) {
    case "docx": {
      const spec = parseDocxSpec(
        deepMerge(deepMerge(input.baseSpec ?? {}, frontMatterSpec), input.spec ?? {}),
      );

      bytes = await (await import("@/modules/documents/docx")).buildDocx({
        content: body,
        fileName,
        spec,
        resolveImage: input.resolveImage,
      });
      break;
    }
    case "pdf": {
      const spec = parsePdfSpec(
        deepMerge(deepMerge(input.baseSpec ?? {}, frontMatterSpec), input.spec ?? {}),
      );

      bytes = await (await import("@/modules/documents/pdf")).buildPdf({
        content: body,
        fileName,
        spec,
        resolveImage: input.resolveImage,
      });
      break;
    }
    case "pptx": {
      const spec = parsePptxSpec(
        deepMerge(deepMerge(input.baseSpec ?? {}, frontMatterSpec), input.spec ?? {}),
      );

      bytes = await (await import("@/modules/documents/pptx")).buildPptx({
        content: body,
        fileName,
        spec,
        resolveImage: input.resolveImage,
      });
      break;
    }
    case "xlsx": {
      const spec = parseXlsxSpec(
        deepMerge(deepMerge(input.baseSpec ?? {}, frontMatterSpec), input.spec ?? {}),
      );

      bytes = await (await import("@/modules/documents/xlsx")).buildXlsx({
        content: body,
        fileName,
        spec,
      });
      break;
    }
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
