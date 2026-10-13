/**
 * Audio-asset helpers for video renders with sound.
 *
 * A video's `MOBILE_AGENT_VIDEO.audio` schedule can reference workspace audio
 * files with `file: "workspace://<id>"`. The hidden render WebView cannot read
 * the workspace itself, so the `renderVideo` tool inlines each referenced file
 * as a data URI before the document is recorded. The helpers here are pure
 * (no react-native imports) so they can be unit-tested in Node; the in-WebView
 * audio engine lives in the recorder string in video-recorder.ts.
 */

export const MAX_AUDIO_FILE_BYTES = 15 * 1024 * 1024;

const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
]);

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  weba: "audio/webm",
};

const WORKSPACE_ID_PATTERN = /workspace:\/\/([A-Za-z0-9][A-Za-z0-9_-]*)/g;

export function extractWorkspaceAudioIds(html: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  WORKSPACE_ID_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORKSPACE_ID_PATTERN.exec(html)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      ids.push(match[1]);
    }
  }
  return ids;
}

export function resolveAudioMimeType(
  mimeType: string | null | undefined,
  displayName: string,
): string | null {
  const normalized = (mimeType ?? "").trim().toLowerCase();
  if (normalized && SUPPORTED_AUDIO_MIME_TYPES.has(normalized)) {
    return normalized;
  }
  const extension = displayName.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_MIME_BY_EXTENSION[extension] ?? null;
}

export function assertAudioFileUsable(
  displayName: string,
  mimeType: string | null | undefined,
  sizeBytes: number,
): string {
  const resolved = resolveAudioMimeType(mimeType, displayName);
  if (!resolved) {
    throw new Error(
      `Audio file "${displayName}" is not a supported format. Use MP3, WAV, M4A, AAC, OGG, or WebM audio.`,
    );
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Audio file "${displayName}" appears to be empty.`);
  }
  if (sizeBytes > MAX_AUDIO_FILE_BYTES) {
    throw new Error(
      `Audio file "${displayName}" is too large (${formatBytes(sizeBytes)}). Keep audio files under ${formatBytes(MAX_AUDIO_FILE_BYTES)}.`,
    );
  }
  return resolved;
}

export function buildAudioDataUri(
  mimeType: string,
  bytes: Uint8Array,
): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
    );
  }
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(bytes).toString("base64")
      : btoa(binary);
  return `data:${mimeType};base64,${base64}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Best-effort read of the contract-level `duration` (seconds) from the HTML.
 * Takes the first `duration:` after the `MOBILE_AGENT_VIDEO` marker, which by
 * contract convention is the top-level field (audio cue timings come later).
 * Returns null when it cannot be determined — callers must treat that as
 * "unknown", never as a mismatch.
 */
export function readContractDuration(html: string): number | null {
  const marker = html.indexOf("MOBILE_AGENT_VIDEO");
  if (marker === -1) return null;
  const match = /duration\s*:\s*(\d+(?:\.\d+)?)/.exec(html.slice(marker));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
