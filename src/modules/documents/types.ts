export type DocumentFormat = "docx" | "pdf" | "pptx" | "xlsx";

export const DOCUMENT_FORMATS: readonly DocumentFormat[] = [
  "docx",
  "pdf",
  "pptx",
  "xlsx",
] as const;

export const DOCUMENT_MIME_TYPES: Record<DocumentFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const DOCUMENT_EXTENSIONS: Record<DocumentFormat, string> = {
  docx: ".docx",
  pdf: ".pdf",
  pptx: ".pptx",
  xlsx: ".xlsx",
};

export type DocumentFormatDescriptor = {
  extension: string;
  mimeType: string;
};

export function isDocumentFormat(value: string): value is DocumentFormat {
  return (DOCUMENT_FORMATS as readonly string[]).includes(value);
}

/** A single styled segment of inline text. */
export type InlineRun = {
  bold?: boolean;
  code?: boolean;
  italic?: boolean;
  text: string;
};

export type DocumentBlock =
  | { level: number; text: string; type: "heading" }
  | { runs: InlineRun[]; type: "paragraph" }
  | { items: InlineRun[][]; ordered: boolean; type: "list" }
  | { text: string; type: "code" }
  | { headers: string[]; rows: string[][]; type: "table" }
  | { type: "pageBreak" };

export type BuildDocumentInput = {
  content: string;
  fileName?: string;
  format: DocumentFormat;
};

export type BuiltDocument = {
  bytes: Uint8Array;
  fileName: string;
  format: DocumentFormat;
  mimeType: string;
};
