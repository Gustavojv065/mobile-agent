import type { WorkspaceRepository } from "@/core/db/database";
import { resolveWorkspaceFile } from "@/core/services/workspace-file-service";
import {
  assertAudioFileUsable,
  buildAudioDataUri,
  extractWorkspaceAudioIds,
} from "@/modules/preview/video-audio";

/**
 * Image/clip helpers for video scenes with user visuals.
 *
 * A scene draws user-provided workspace files with plain DOM elements —
 * `<img src="workspace://<id>">` painted via `drawImage`, or a muted
 * `<video src="workspace://<id>">` driven by scene JS — and the `renderVideo`
 * tool inlines each referenced file as a data URI before recording (the
 * hidden render WebView cannot read the workspace itself, and data URIs keep
 * the canvas readback clean, which export frame capture requires).
 *
 * Extraction is scoped to the element (`<img>` vs `<video>`/`<source>`) so
 * asset kinds are never confused with each other or with `file:` audio
 * tracks. Like video-audio.ts this module is pure apart from the workspace
 * service, so it can be unit-tested in Node with a stubbed repository.
 */

export const MAX_IMAGE_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_FILE_BYTES = 15 * 1024 * 1024;

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const SUPPORTED_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm"]);

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
};

const IMG_SRC_PATTERN =
  /<img\b[^>]*\bsrc\s*=\s*["']workspace:\/\/([A-Za-z0-9][A-Za-z0-9_-]*)/gi;
const VIDEO_SRC_PATTERN =
  /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']workspace:\/\/([A-Za-z0-9][A-Za-z0-9_-]*)/gi;

function extractScopedIds(html: string, pattern: RegExp): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      ids.push(match[1]);
    }
  }
  return ids;
}

/** Ids referenced by `<img src="workspace://<id>">`. */
export function extractWorkspaceImageIds(html: string): string[] {
  return extractScopedIds(html, IMG_SRC_PATTERN);
}

/** Ids referenced by `<video>`/`<source src="workspace://<id>">`. */
export function extractWorkspaceVideoIds(html: string): string[] {
  return extractScopedIds(html, VIDEO_SRC_PATTERN);
}

/**
 * True when any workspace reference (image, clip, or audio-track) remains.
 * The export/preview WebViews cannot resolve `workspace://` themselves, so
 * a document that still has refs after inlining would record missing media.
 */
export function hasWorkspaceRefs(html: string): boolean {
  return (
    extractWorkspaceImageIds(html).length > 0 ||
    extractWorkspaceVideoIds(html).length > 0 ||
    extractWorkspaceAudioIds(html).length > 0
  );
}

export function resolveImageMimeType(
  mimeType: string | null | undefined,
  displayName: string,
): string | null {
  const normalized = (mimeType ?? "").trim().toLowerCase();
  if (normalized && SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) {
    return normalized;
  }
  const extension = displayName.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

export function resolveVideoMimeType(
  mimeType: string | null | undefined,
  displayName: string,
): string | null {
  const normalized = (mimeType ?? "").trim().toLowerCase();
  if (normalized && SUPPORTED_VIDEO_MIME_TYPES.has(normalized)) {
    return normalized;
  }
  const extension = displayName.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_MIME_BY_EXTENSION[extension] ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function assertImageFileUsable(
  displayName: string,
  mimeType: string | null | undefined,
  sizeBytes: number,
): string {
  const resolved = resolveImageMimeType(mimeType, displayName);
  if (!resolved) {
    throw new Error(
      `File "${displayName}" is not a supported image. Use JPEG, PNG, WebP, or GIF images.`,
    );
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`File "${displayName}" appears to be empty.`);
  }
  if (sizeBytes > MAX_IMAGE_FILE_BYTES) {
    throw new Error(
      `File "${displayName}" is too large (${formatBytes(sizeBytes)}). Keep scene images under ${formatBytes(MAX_IMAGE_FILE_BYTES)}.`,
    );
  }
  return resolved;
}

export function assertVideoFileUsable(
  displayName: string,
  mimeType: string | null | undefined,
  sizeBytes: number,
): string {
  const resolved = resolveVideoMimeType(mimeType, displayName);
  if (!resolved) {
    throw new Error(
      `File "${displayName}" is not a supported video clip. Use MP4 or WebM clips.`,
    );
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`File "${displayName}" appears to be empty.`);
  }
  if (sizeBytes > MAX_VIDEO_FILE_BYTES) {
    throw new Error(
      `File "${displayName}" is too large (${formatBytes(sizeBytes)}). Keep scene clips under ${formatBytes(MAX_VIDEO_FILE_BYTES)}.`,
    );
  }
  return resolved;
}

async function inlineAssetUris(
  html: string,
  repository: WorkspaceRepository,
  ids: string[],
  kind: "image" | "clip" | "audio",
  assertUsable: (
    displayName: string,
    mimeType: string | null | undefined,
    sizeBytes: number,
  ) => string,
): Promise<{ html: string; files: string[] }> {
  const files: string[] = [];
  let next = html;
  for (const id of ids) {
    const record = await repository.getById(id);
    if (!record) {
      throw new Error(
        `No workspace ${kind} file found with id ${id}. Save it to the workspace first, or remove its reference from the scene.`,
      );
    }
    const file = resolveWorkspaceFile(record.relativePath);
    if (!file.exists) {
      throw new Error(
        `File "${record.displayName}" is no longer available locally.`,
      );
    }
    const bytes = await file.bytes();
    const mimeType = assertUsable(record.displayName, record.mimeType, bytes.length);
    files.push(record.displayName);
    next = next
      .split(`workspace://${id}`)
      .join(buildAudioDataUri(mimeType, bytes));
  }
  return { html: next, files };
}

/**
 * Inlines `<img>`-referenced workspace files as data URIs. Pure apart from
 * the workspace read, mirroring the audio inliner below.
 */
export function inlineImageAssets(
  html: string,
  repository: WorkspaceRepository,
): Promise<{ html: string; imageFiles: string[] }> {
  const ids = extractWorkspaceImageIds(html);
  if (ids.length === 0) {
    return Promise.resolve({ html, imageFiles: [] });
  }
  return inlineAssetUris(html, repository, ids, "image", assertImageFileUsable).then(
    ({ html: inlined, files }) => ({ html: inlined, imageFiles: files }),
  );
}

/**
 * Inlines `<video>`/`<source>`-referenced workspace clips as data URIs.
 * Clips play muted and scene-driven; the recorder captures its own audio
 * graph, never page audio.
 */
export function inlineVideoAssets(
  html: string,
  repository: WorkspaceRepository,
): Promise<{ html: string; videoFiles: string[] }> {
  const ids = extractWorkspaceVideoIds(html);
  if (ids.length === 0) {
    return Promise.resolve({ html, videoFiles: [] });
  }
  return inlineAssetUris(html, repository, ids, "clip", assertVideoFileUsable).then(
    ({ html: inlined, files }) => ({ html: inlined, videoFiles: files }),
  );
}

/**
 * Replaces every `workspace://<id>` audio-track reference with a data URI the
 * export/preview WebViews can fetch. Shared by the `renderVideo` tool and the
 * manual export button so both produce the same soundtrack.
 */
export function inlineAudioAssets(
  html: string,
  repository: WorkspaceRepository,
): Promise<{ html: string; audioFiles: string[] }> {
  const ids = extractWorkspaceAudioIds(html);
  if (ids.length === 0) {
    return Promise.resolve({ html, audioFiles: [] });
  }
  return inlineAssetUris(html, repository, ids, "audio", assertAudioFileUsable).then(
    ({ html: inlined, files }) => ({ html: inlined, audioFiles: files }),
  );
}
