/**
 * Shared filename helpers. This module imports nothing from the app so it
 * can be used by both workspace-file-service and external-folder-service
 * without creating a require cycle.
 */

export function sanitizeFileName(name: string) {
  const trimmed = name.trim();

  if (!trimmed) {
    return "untitled.txt";
  }

  const normalized = trimmed
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "untitled.txt";
}

export function inferFileNameFromUrl(url: string) {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const lastSegment = withoutQuery.split("/").filter(Boolean).pop() ?? "";

  if (!lastSegment) {
    return "";
  }

  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

const MEDIA_MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
  webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
  aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/opus", flac: "audio/flac",
};

export function inferMimeType(fileName: string) {
  const lowerName = fileName.toLowerCase();
  const mediaMime = MEDIA_MIME_TYPES[lowerName.split(".").pop() ?? ""];
  if (mediaMime) return mediaMime;

  if (lowerName.endsWith(".json")) {
    return "application/json";
  }

  if (
    lowerName.endsWith(".js") ||
    lowerName.endsWith(".mjs") ||
    lowerName.endsWith(".cjs")
  ) {
    return "application/javascript";
  }

  if (
    lowerName.endsWith(".ts") ||
    lowerName.endsWith(".mts") ||
    lowerName.endsWith(".cts") ||
    lowerName.endsWith(".tsx") ||
    lowerName.endsWith(".jsx")
  ) {
    return "application/typescript";
  }

  if (
    lowerName.endsWith(".css") ||
    lowerName.endsWith(".scss") ||
    lowerName.endsWith(".sass") ||
    lowerName.endsWith(".less")
  ) {
    return "text/css";
  }

  if (lowerName.endsWith(".html") || lowerName.endsWith(".htm")) {
    return "text/html";
  }

  if (lowerName.endsWith(".svg")) {
    return "image/svg+xml";
  }

  if (lowerName.endsWith(".xml")) {
    return "application/xml";
  }

  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "text/markdown";
  }

  if (lowerName.endsWith(".yml") || lowerName.endsWith(".yaml")) {
    return "application/x-yaml";
  }

  if (lowerName.endsWith(".toml")) {
    return "application/toml";
  }

  if (lowerName.endsWith(".sql")) {
    return "application/sql";
  }

  if (lowerName.endsWith(".csv") || lowerName.endsWith(".tsv")) {
    return "text/csv";
  }

  if (lowerName.endsWith(".pdf")) {
    return "application/pdf";
  }

  if (lowerName.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (lowerName.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  if (lowerName.endsWith(".pptx")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }

  if (
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".log") ||
    lowerName.endsWith(".env") ||
    lowerName.endsWith(".sh") ||
    lowerName.endsWith(".py") ||
    lowerName.endsWith(".ini") ||
    lowerName.endsWith(".conf")
  ) {
    return "text/plain";
  }

  return "application/octet-stream";
}
