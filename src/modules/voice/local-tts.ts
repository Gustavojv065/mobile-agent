import { File } from "expo-file-system";
import { getLocalTtsModule } from "local-tts";

/**
 * On-device narration: turns a script into workspace WAV files with the
 * device's own text-to-speech voices — no network, no third-party endpoint.
 *
 * Long scripts are split at sentence boundaries and synthesized part by part
 * (the engine caps a single call at 4000 chars); each part is *moved* into
 * the workspace, never read into the JS heap. Parts come back with `start`
 * offsets so the agent can schedule them back-to-back as `file:` tracks and,
 * via `transcribeAudio`, drive captions from the `speech` contract.
 *
 * The native module is Android-only; everywhere else (or on builds without
 * it) every entry point throws an actionable error pointing at the network
 * TTS fallback documented in the html-video skill.
 */

export const NARRATION_CHUNK_CHARS = 1500;
export const NARRATION_MIME_TYPE = "audio/wav";

export type NarrationPart = {
  fileId: string;
  displayName: string;
  /** `workspace://` link for `file:` tracks. */
  link: string;
  /** Seconds from the narration start — schedule this part at `start`. */
  start: number;
  /** Part length in seconds. */
  duration: number;
};

export type NarrationWorkspace = {
  createDocumentFileFromFile(input: {
    source: File;
    mimeType: string;
    name: string;
  }): Promise<{ id: string; displayName: string }>;
};

export type SynthesizeNarrationOptions = {
  /** BCP-47 tag such as "en" or "es-ES". Omit for the device default. */
  language?: string;
  /** 0.25–4, default 1. */
  rate?: number;
  /** 0.25–4, default 1. */
  pitch?: number;
  /** Base file name; parts become `<name>-1.wav`, … Default "narration". */
  name?: string;
  workspaceService: NarrationWorkspace;
  signal?: AbortSignal;
};

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Splits a script into synthesizable chunks at sentence boundaries, packing
 * short sentences together up to `maxChars`. A single over-long sentence is
 * hard-split on word boundaries. Pure (no native imports) for unit tests.
 */
export function chunkNarrationText(
  text: string,
  maxChars: number = NARRATION_CHUNK_CHARS,
): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences =
    clean
      .match(/[^.!?…]+[.!?…]+["')\]]?|[^.!?…]+$/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? [clean];

  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current) chunks.push(current);
    current = "";
  };
  const appendWord = (word: string) => {
    if (current && `${current} ${word}`.length > maxChars) push();
    current = current ? `${current} ${word}` : word;
  };

  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      if (current && `${current} ${sentence}`.length > maxChars) push();
      current = current ? `${current} ${sentence}` : sentence;
      continue;
    }
    push();
    for (const word of sentence.split(" ")) appendWord(word);
    push();
  }
  push();
  return chunks;
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) fail("Narration was cancelled.");
}

/**
 * Synthesizes the script and saves each part as a workspace WAV.
 * Returns the parts in order with back-to-back `start` offsets.
 */
export async function synthesizeNarrationParts(
  text: string,
  options: SynthesizeNarrationOptions,
): Promise<{
  parts: NarrationPart[];
  totalDuration: number;
  language: string;
}> {
  const module = getLocalTtsModule();
  if (!module) {
    fail(
      "On-device narration needs an Android build with the local TTS module. " +
        "Use the network TTS endpoint documented in the html-video skill instead.",
    );
  }
  const chunks = chunkNarrationText(text);
  if (chunks.length === 0) fail("Nothing to speak: the text is empty.");

  const baseName = (options.name ?? "narration").trim() || "narration";
  const parts: NarrationPart[] = [];
  let cursor = 0;

  for (const [index, chunk] of chunks.entries()) {
    checkAborted(options.signal);
    const synth = await module.synthesize(chunk, {
      ...(options.language ? { language: options.language } : {}),
      ...(options.rate != null ? { rate: options.rate } : {}),
      ...(options.pitch != null ? { pitch: options.pitch } : {}),
    });
    checkAborted(options.signal);

    const saved = await options.workspaceService.createDocumentFileFromFile({
      source: new File(synth.uri),
      mimeType: NARRATION_MIME_TYPE,
      name:
        chunks.length === 1
          ? `${baseName}.wav`
          : `${baseName}-${index + 1}.wav`,
    });
    const duration = Math.round((synth.durationMs / 1000) * 100) / 100;
    const start = Math.round(cursor * 100) / 100;
    parts.push({
      fileId: saved.id,
      displayName: saved.displayName,
      link: `workspace://${saved.id}`,
      start,
      duration,
    });
    cursor += duration;
  }

  return {
    parts,
    totalDuration: Math.round(cursor * 100) / 100,
    language: options.language ?? "device-default",
  };
}
