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

/**
 * Video containers the audio tools also accept: only the audio track is
 * decoded (via the WebView's `decodeAudioData`, which demuxes them) for
 * analysis/transcription. Frames still go through `getVideoFrame`.
 */
const SUPPORTED_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
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
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
};

/**
 * Audio ids are `file:` keys in the schedule (`{ file: "workspace://<id>" }`).
 * Scoped to the key — not a whole-HTML scan — so `workspace://` references in
 * `<img>`/`<video>` tags (inlined separately) are never mistaken for audio.
 */
const AUDIO_FILE_PATTERN = /file\s*:\s*["']workspace:\/\/([A-Za-z0-9][A-Za-z0-9_-]*)/g;

export function extractWorkspaceAudioIds(html: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  AUDIO_FILE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AUDIO_FILE_PATTERN.exec(html)) !== null) {
    // `file` must be a full key: `profile:` and `sourceFile:` do not count.
    const prev = match.index > 0 ? html[match.index - 1] : "";
    if (/[A-Za-z0-9_$]/.test(prev)) continue;
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
  if (
    normalized &&
    (SUPPORTED_AUDIO_MIME_TYPES.has(normalized) ||
      SUPPORTED_VIDEO_MIME_TYPES.has(normalized))
  ) {
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
      `Audio file "${displayName}" is not a supported format. Use MP3, WAV, M4A, AAC, OGG, or WebM audio — or a video file (MP4, MOV, WebM) to analyze its soundtrack.`,
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
  // Prefer Buffer: a single native copy. The binary-string loop below costs
  // a second full-size string plus per-chunk Array garbage — skip it entirely
  // when Buffer exists (15 MB in → ~20 MB out, not ~40 MB transient).
  if (typeof Buffer !== "undefined") {
    return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  }
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
    );
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Best-effort read of the contract-level `duration` (seconds) from the HTML.
 *
 * Mirrors JS semantics instead of grabbing the first `duration:` in sight:
 * an explicit post-creation override (`MOBILE_AGENT_VIDEO.duration = 21`)
 * wins outright, otherwise the LAST top-level key of the contract object
 * literal wins (duplicate keys). Nested cue timings (audio tracks live
 * deeper) and quoted text are ignored. Returns null when nothing can be
 * determined — callers must treat that as "unknown", never as a mismatch.
 */
export function readContractDuration(html: string): number | null {
  const marker = html.indexOf("MOBILE_AGENT_VIDEO");
  if (marker === -1) return null;
  const tail = html.slice(marker);

  // An explicit post-creation override wins outright.
  let override: number | null = null;
  const assignRe = /MOBILE_AGENT_VIDEO\s*\.\s*duration\s*=\s*(\d+(?:\.\d+)?)/g;
  let assignMatch: RegExpExecArray | null;
  while ((assignMatch = assignRe.exec(tail)) !== null) {
    const value = Number(assignMatch[1]);
    if (Number.isFinite(value)) override = value;
  }
  if (override != null) return override;

  return readLastContractNumber(html, "duration");
}

/**
 * Aspect ratio (width / height) of the video canvas as declared in the
 * contract literal, or null when either dimension is absent/non-positive —
 * callers must treat that as "unknown", never as "16:9".
 */
export function readContractAspect(html: string): number | null {
  const width = readLastContractNumber(html, "width");
  const height = readLastContractNumber(html, "height");
  if (
    width == null ||
    height == null ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(width / height)
  ) {
    return null;
  }
  return width / height;
}

/**
 * The LAST top-level numeric `key:` of the contract object literal.
 *
 * Mirrors JS semantics instead of grabbing the first match in sight: the
 * last top-level key of the literal wins (duplicate keys). Nested cue
 * timings (audio tracks live deeper) and quoted text are ignored.
 */
function readLastContractNumber(
  html: string,
  key: string,
): number | null {
  const marker = html.indexOf("MOBILE_AGENT_VIDEO");
  if (marker === -1) return null;

  // Strip strings/comments so quoted text can't fake a key, then walk the
  // contract literal tracking brace depth. Sticky regexes keep this linear
  // even for large documents.
  const code = html
    .slice(marker)
    .replace(
      /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      " ",
    );
  const literalOpen = code.search(/MOBILE_AGENT_VIDEO\s*=\s*\{/);
  if (literalOpen === -1) return null;

  const keyRe = new RegExp(`${key}\\s*:`, "gy");
  const numRe = new RegExp(`${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)`, "gy");
  let depth = 0;
  let last: number | null = null;
  const start = code.indexOf("{", literalOpen);
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth <= 0) break;
      continue;
    }
    if (depth !== 1 || ch !== key[0]) continue;
    keyRe.lastIndex = i;
    if (!keyRe.exec(code)) continue;
    // Object-literal keys follow `{` or `,` — skips ternaries and labels.
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j] ?? "")) j -= 1;
    const prev = code[j] ?? "";
    if (prev !== "{" && prev !== ",") continue;
    numRe.lastIndex = i;
    const num = numRe.exec(code);
    if (num) {
      const value = Number(num[1]);
      if (Number.isFinite(value)) last = value;
    }
  }
  return last;
}
