import type { WorkspaceRepository } from "@/core/db/database";
import { resolveWorkspaceFile } from "@/core/services/workspace-file-service";
import {
  assertAudioFileUsable,
  buildAudioDataUri,
  extractWorkspaceAudioIds,
} from "@/modules/preview/video-audio";
import type { File } from "expo-file-system";

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
/**
 * Served clips bypass the heap entirely (loopback HTTP + range requests),
 * so the only ceiling is decoder sanity, not memory. Above this, clips
 * transcode down; the 15 MB figure stays as the data-URI fallback cap
 * (heap protection on builds without the server).
 */
export const MAX_DIRECT_SERVE_BYTES = 200 * 1024 * 1024;
/**
 * Transcode target: comfortably under the inline cap so the base64
 * inflation (~33%) still leaves headroom in the render document.
 */
export const TRANSCODE_TARGET_BYTES = 12 * 1024 * 1024;
export const TRANSCODE_MAX_DIMENSION = 1280;

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

/** Container the WebView cannot reliably play: always converted to MP4. */
const TRANSCODE_ONLY_VIDEO_MIME_TYPES = new Set(["video/quicktime"]);

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
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
  if (
    normalized &&
    (SUPPORTED_VIDEO_MIME_TYPES.has(normalized) ||
      TRANSCODE_ONLY_VIDEO_MIME_TYPES.has(normalized))
  ) {
    return normalized;
  }
  const extension = displayName.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_MIME_BY_EXTENSION[extension] ?? null;
}

/** True for containers the WebView cannot play directly (always converted). */
export function isTranscodeOnlyVideoMimeType(resolved: string): boolean {
  return TRANSCODE_ONLY_VIDEO_MIME_TYPES.has(resolved);
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
      `File "${displayName}" is not a supported video clip. Use MP4, WebM, or MOV clips.`,
    );
  }
  if (isTranscodeOnlyVideoMimeType(resolved)) {
    // MOV never inlines directly (unreliable WebView playback) — it must go
    // through prepareClipBytes. Reaching here means the caller bypassed it.
    throw new Error(
      `File "${displayName}" needs conversion before use as a scene clip.`,
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
  warnings?: string[],
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
    // Stat before reading: a 200 MB source must never enter the JS heap
    // just to be rejected. Over-cap clips get a transcode attempt, and MOV
    // always converts (unreliable WebView playback); other kinds fail fast
    // on the stat alone.
    const statSize = typeof file.size === "number" ? file.size : null;
    const clipMime =
      kind === "clip" ? resolveVideoMimeType(record.mimeType, record.displayName) : null;
    const needsTranscode =
      kind === "clip" &&
      clipMime !== null &&
      (isTranscodeOnlyVideoMimeType(clipMime) ||
        (statSize != null && statSize > MAX_VIDEO_FILE_BYTES));
    if (needsTranscode) {
      const prepared = await prepareClipBytes(record.id, record.displayName, record.mimeType, file, statSize ?? 0, true);
      if (!prepared.bytes) {
        throw new Error(
          `File "${record.displayName}" is too large. Keep scene clips under ${formatClipBytes(MAX_VIDEO_FILE_BYTES)}.`,
        );
      }
      files.push(record.displayName);
      next = next
        .split(`workspace://${id}`)
        .join(buildAudioDataUri(prepared.mimeType, prepared.bytes));
      if (prepared.warning && warnings) warnings.push(prepared.warning);
      continue;
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
 * Over-cap clip handling: transcode down via the native module instead of
 * failing. Returns scene-ready bytes plus a user-facing warning. Throws the
 * original oversize error when transcoding is unavailable or cannot fit.
 */
async function prepareClipBytes(
  id: string,
  displayName: string,
  mimeType: string | null | undefined,
  file: File,
  statSize: number,
  readBytes: boolean,
): Promise<{ bytes: Uint8Array | null; mimeType: string; warning?: string; cacheName: string }> {
  const resolved = resolveVideoMimeType(mimeType, displayName);
  if (!resolved) {
    throw new Error(
      `File "${displayName}" is not a supported video clip. Use MP4, WebM, or MOV clips.`,
    );
  }
  const needsConversion = isTranscodeOnlyVideoMimeType(resolved);
  const tooLarge = new Error(
    `File "${displayName}" is too large (${statSize > 0 ? formatClipBytes(statSize) : "over the budget"}). Keep scene clips under ${formatClipBytes(MAX_VIDEO_FILE_BYTES)}.`,
  );
  // Lazy: expo-file-system and the native module pull react-native, which
  // cannot even parse in unit tests. Only the over-cap path pays for it.
  let transcodeClip: ((inputPath: string, outputPath: string, maxBytes: number, maxDimension: number) => Promise<{ path: string; width: number; height: number; sizeBytes: number }>) | null = null;
  let cacheFileFor: ((name: string) => { uri: string; exists: boolean; size: number | null; bytes: () => Promise<Uint8Array>; delete: () => void }) | null = null;
  try {
    const [fs, native] = await Promise.all([
      import("expo-file-system"),
      import("html-video-export"),
    ]);
    const module = native.getHtmlVideoExportModule();
    if (module && typeof module.transcodeClip === "function") {
      transcodeClip = module.transcodeClip.bind(module);
      cacheFileFor = (name: string) => new fs.File(fs.Paths.cache, name) as unknown as {
        uri: string; exists: boolean; size: number | null; bytes: () => Promise<Uint8Array>; delete: () => void;
      };
    }
  } catch {
    transcodeClip = null;
  }
  if (!transcodeClip || !cacheFileFor) {
    throw tooLarge;
  }
  const inputUri = file.uri;
  const inputPath = inputUri.startsWith("file://") ? inputUri.slice("file://".length) : inputUri;
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cacheName = `clip-${safeId}-${statSize}.mp4`;
  const outFile = cacheFileFor(cacheName);
  let transcodedSize: number | null = null;
  try {
    if (!outFile.exists) {
      const outPath = outFile.uri.startsWith("file://")
        ? outFile.uri.slice("file://".length)
        : outFile.uri;
      const done = await transcodeClip(inputPath, outPath, TRANSCODE_TARGET_BYTES, TRANSCODE_MAX_DIMENSION);
      if (done && typeof done.sizeBytes === "number") transcodedSize = done.sizeBytes;
    }
    const bytes = readBytes ? await outFile.bytes() : null;
    if (readBytes && (!bytes || bytes.length === 0 || bytes.length > MAX_VIDEO_FILE_BYTES)) {
      try { outFile.delete(); } catch { /* best effort */ }
      throw tooLarge;
    }
    const outSize = bytes ? bytes.length : (transcodedSize ?? outFile.size ?? statSize);
    const sizeText = outSize > 0 ? formatClipBytes(outSize) : "unknown size";
    return {
      bytes,
      mimeType: "video/mp4",
      cacheName,
      warning: needsConversion
        ? `"${displayName}" is MOV, which scenes cannot play directly — converted to MP4 (${sizeText}). Detail may be softer; attach an MP4 to skip this.`
        : `"${displayName}" was ${statSize > 0 ? formatClipBytes(statSize) : "over the budget"} — over the ${formatClipBytes(MAX_VIDEO_FILE_BYTES)} scene-clip budget, so it was compressed to ${sizeText}. Detail may be softer; attach a smaller file or trim it to skip this.`,
    };
  } catch (error) {
    if (error === tooLarge) throw error;
    throw new Error(
      `File "${displayName}" is too large (${statSize > 0 ? formatClipBytes(statSize) : "over the budget"}) and could not be compressed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatClipBytes(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/**
 * Inlines `<video>`/`<source>`-referenced workspace clips.
 * Clips play muted and scene-driven; the recorder captures its own audio
 * graph, never page audio.
 *
 * Preferred path serves clips as same-origin loopback URLs (zero heap
 * inflation, byte-range seeking, clean canvas readback). Over-cap clips
 * and MOV are transcoded to cache first, with a warning per file. When the
 * asset server is unavailable the legacy data-URI path runs instead, and
 * only unfixable clips throw.
 */
export function inlineVideoAssets(
  html: string,
  repository: WorkspaceRepository,
): Promise<{ html: string; videoFiles: string[]; warnings: string[] }> {
  const ids = extractWorkspaceVideoIds(html);
  if (ids.length === 0) {
    return Promise.resolve({ html, videoFiles: [], warnings: [] });
  }
  const warnings: string[] = [];
  return inlineClipRefs(html, repository, ids, warnings).then(
    ({ html: out, files }) => ({ html: out, videoFiles: files, warnings }),
  );
}

async function inlineClipRefs(
  html: string,
  repository: WorkspaceRepository,
  ids: string[],
  warnings: string[],
): Promise<{ html: string; files: string[] }> {
  const { ensureAssetServer, workspaceFileUrl, cacheFileUrl } = await import(
    "@/modules/preview/asset-server"
  );
  const baseUrl = await ensureAssetServer().catch(() => null);
  if (!baseUrl) {
    return inlineAssetUris(html, repository, ids, "clip", assertVideoFileUsable, warnings);
  }
  const files: string[] = [];
  let next = html;
  for (const id of ids) {
    const record = await repository.getById(id);
    if (!record) {
      throw new Error(
        `No workspace clip file found with id ${id}. Save it to the workspace first, or remove its reference from the scene.`,
      );
    }
    const resolved = resolveVideoMimeType(record.mimeType, record.displayName);
    if (!resolved) {
      throw new Error(
        `File "${record.displayName}" is not a supported video clip. Use MP4, WebM, or MOV clips.`,
      );
    }
    const file = resolveWorkspaceFile(record.relativePath);
    if (!file.exists) {
      throw new Error(
        `File "${record.displayName}" is no longer available locally.`,
      );
    }
    files.push(record.displayName);
    const statSize = typeof file.size === "number" ? file.size : null;
    // Served clips bypass the heap: only absurd files (>200 MB) or MOV
    // transcode. Anything smaller serves at full quality, no warning.
    const convert =
      isTranscodeOnlyVideoMimeType(resolved) ||
      (statSize != null && statSize > MAX_DIRECT_SERVE_BYTES);
    if (!convert) {
      next = next
        .split(`workspace://${id}`)
        .join(workspaceFileUrl(baseUrl, record.relativePath));
      continue;
    }
    const prepared = await prepareClipBytes(record.id, record.displayName, record.mimeType, file, statSize ?? 0, false);
    next = next
      .split(`workspace://${id}`)
      .join(cacheFileUrl(baseUrl, prepared.cacheName));
    if (prepared.warning) warnings.push(prepared.warning);
  }
  return { html: next, files };
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
