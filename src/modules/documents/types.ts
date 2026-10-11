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
  href?: string;
  italic?: boolean;
  text: string;
};

export type DocumentBlock =
  | { level: number; text: string; type: "heading" }
  | { runs: InlineRun[]; type: "paragraph" }
  | { items: InlineRun[][]; ordered: boolean; type: "list" }
  | { text: string; type: "code" }
  | { headers: string[]; rows: string[][]; type: "table" }
  | {
      /** Alternative text shown when the image cannot be rendered. */
      alt: string;
      /** Workspace-relative path or a base64 data URI. */
      src: string;
      /** Optional explicit width in pixels. */
      widthPx?: number;
      type: "image";
    }
  | { type: "pageBreak" };

export type BuildDocumentInput = {
  content: string;
  fileName?: string;
  format: DocumentFormat;
  /**
   * Optional partial format spec for the requested format. Merged on top of
   * the document's front-matter `format:` block (if any) and validated before
   * building. All four formats (`docx`, `xlsx`, `pptx`, `pdf`) honor a spec.
   */
  spec?: Record<string, unknown>;
  /**
   * Stored style snapshot (for example from an imported .docx) applied as the
   * base styling below any front-matter `format:` block or `spec` parameter.
   * Precedence: defaults < baseSpec < front-matter < spec.
   */
  baseSpec?: Record<string, unknown>;
  /**
   * Resolves an image `src` (non-data-URI) to bytes. Builders default to
   * data-URI decoding only; workspace resolution is wired in by callers that
   * have filesystem access.
   */
  resolveImage?: (src: string) => Promise<Uint8Array>;
};

export type BuiltDocument = {
  bytes: Uint8Array;
  fileName: string;
  format: DocumentFormat;
  mimeType: string;
};
