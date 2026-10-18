import type { WorkspaceFile } from "@/core/types/app-state";

/**
 * A short human label for the kind of a file ("Word document", "MP3 audio").
 * Mime types are for machines — vendor strings like
 * `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
 * never reach the UI, so the helper can never return a string with a slash.
 *
 * Matching order:
 *  1. the `displayName` file extension (imports can carry a mime guess the
 *     exporter never set, and the name is what the user sees standing out),
 *  2. exact mime matches (with parameters like `charset` stripped),
 *  3. vendor and family mime patterns (`vnd.openxmlformats-*`, subtypes),
 *  4. generic family fallbacks (`image/` → "Image file").
 *
 * The extension and mime can agree to disagree; when both exist, the
 * extension wins because exporters (e.g. some docx tools) label mimes as
 * `application/octet-stream`.
 */
export function formatFileKindLabel(
  file: Pick<WorkspaceFile, "displayName" | "mimeType">,
): string {
  const extensionLabel = extensionOf(file.displayName)
    ? EXTENSION_LABELS[extensionOf(file.displayName)]
    : undefined;
  if (extensionLabel) {
    return extensionLabel;
  }

  const mimeType = (file.mimeType ?? "*/*").split(";")[0].trim().toLowerCase();
  const exactLabel = MIME_LABELS[mimeType];
  if (exactLabel) {
    return exactLabel;
  }

  for (const [pattern, label] of MIME_PATTERN_LABELS) {
    if (pattern.test(mimeType)) {
      return label;
    }
  }

  if (mimeType !== "*/*") {
    const [main] = mimeType.split("/");
    if (main === "image") {
      return "Image file";
    }
    if (main === "video") {
      return "Video file";
    }
    if (main === "audio") {
      return "Audio file";
    }
    if (main === "text") {
      return "Text file";
    }
    return "File";
  }

  return "Unknown type";
}

export function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");

  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

const EXTENSION_LABELS: Record<string, string> = {
  ".7z": "Archive",
  ".aac": "AAC audio",
  ".amr": "AMR audio",
  ".avi": "AVI video",
  ".avif": "AVIF image",
  ".bmp": "BMP image",
  ".csv": "CSV",
  ".doc": "Word document",
  ".docx": "Word document",
  ".flac": "FLAC audio",
  ".gif": "GIF image",
  ".gz": "Archive",
  ".htm": "HTML",
  ".html": "HTML",
  ".heic": "HEIC image",
  ".heif": "HEIF image",
  ".jpeg": "JPEG image",
  ".jpg": "JPEG image",
  ".json": "JSON",
  ".key": "Keynote presentation",
  ".m4a": "M4A audio",
  ".m4v": "MP4 video",
  ".markdown": "Markdown",
  ".md": "Markdown",
  ".mkv": "MKV video",
  ".mov": "MOV video",
  ".mp3": "MP3 audio",
  ".mp4": "MP4 video",
  ".mpeg": "MPEG video",
  ".mpg": "MPEG video",
  ".odp": "OpenDocument presentation",
  ".ods": "OpenDocument spreadsheet",
  ".odt": "OpenDocument text",
  ".oga": "OGG audio",
  ".ogg": "OGG audio",
  ".ogv": "OGG video",
  ".pdf": "PDF document",
  ".png": "PNG image",
  ".ppt": "PowerPoint presentation",
  ".pptx": "PowerPoint presentation",
  ".rtf": "Rich text document",
  ".svg": "SVG image",
  ".tar": "Archive",
  ".tsv": "TSV",
  ".txt": "Text file",
  ".wav": "WAV audio",
  ".webm": "WebM video",
  ".webp": "WebP image",
  ".wma": "WMA audio",
  ".wmv": "WMV video",
  ".xls": "Excel spreadsheet",
  ".xlsx": "Excel spreadsheet",
  ".zip": "ZIP archive",
};

/** Exact mime matches, parameters already stripped. */
const MIME_LABELS: Record<string, string> = {
  "application/gzip": "Archive",
  "application/json": "JSON",
  "application/msword": "Word document",
  "application/pdf": "PDF document",
  "application/rtf": "Rich text document",
  "application/vnd.ms-excel": "Excel spreadsheet",
  "application/vnd.ms-powerpoint": "PowerPoint presentation",
  "application/vnd.oasis.opendocument.presentation": "OpenDocument presentation",
  "application/vnd.oasis.opendocument.spreadsheet": "OpenDocument spreadsheet",
  "application/vnd.oasis.opendocument.text": "OpenDocument text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "PowerPoint presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow":
    "PowerPoint presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "Excel spreadsheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "Word document",
  "application/x-7z-compressed": "Archive",
  "application/x-abiword": "AbiWord document",
  "application/x-apple-diskimage": "Archive",
  "application/x-rar-compressed": "Archive",
  "application/x-tar": "Archive",
  "application/x-zip-compressed": "ZIP archive",
  "application/xhtml+xml": "HTML",
  "application/zip": "ZIP archive",
  "audio/mp4": "M4A audio",
  "image/jpeg": "JPEG image",
  "image/pjpeg": "JPEG image",
  "image/svg+xml": "SVG image",
  "text/csv": "CSV",
  "text/html": "HTML",
  "text/markdown": "Markdown",
  "text/plain": "Text file",
  "text/tab-separated-values": "TSV",
};

/** Families that exact strings cannot nail down (vendor variations). */
const MIME_PATTERN_LABELS: Array<[RegExp, string]> = [
  [/vnd\.openxmlformats-officedocument\.wordprocessingml/, "Word document"],
  [/vnd\.openxmlformats-officedocument\.presentationml/, "PowerPoint presentation"],
  [/vnd\.openxmlformats-officedocument\.spreadsheetml/, "Excel spreadsheet"],
  [/vnd\.oasis\.opendocument\.presentation/, "OpenDocument presentation"],
  [/vnd\.oasis\.opendocument\.spreadsheet/, "OpenDocument spreadsheet"],
  [/vnd\.oasis\.opendocument\.text/, "OpenDocument text"],
  [/^image\/png$/, "PNG image"],
  [/^video\/(3gpp|3gpp2)$/, "3GP video"],
  [/^video\/quicktime$/, "MOV video"],
  [/^video\/x-matroska/, "MKV video"],
  [/^video\/x-msvideo$/, "AVI video"],
  [/^video\/x-flv$/, "FLV video"],
  [/^audio\/(mp3|mpeg|mpga)$/, "MP3 audio"],
  [/^audio\/(ogg|opus)$/, "OGG audio"],
  [/^audio\/(wav|x-wav|wave)$/, "WAV audio"],
  [/^audio\/aac$/, "AAC audio"],
  [/^audio\/(amr|3gpp)$/, "AMR audio"],
  [/^audio\/flac$/, "FLAC audio"],
  [/^text\/x-markdown/, "Markdown"],
];
