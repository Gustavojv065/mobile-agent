import { Platform } from "react-native";

import {
  isModelDownloaded,
  modelFile,
  resolveTranscriptionModel,
  type WhisperLanguage,
  type WhisperModelId,
} from "./models";
import { floatToPcm16, prepareWhisperAudio } from "./pcm";

/** One timed span of recognized speech (seconds into the source audio). */
export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type Transcript = {
  /** Full trimmed transcript text. */
  text: string;
  /** Detected (or requested) language code. */
  language: string;
  /** Duration of the analyzed audio in seconds. */
  duration: number;
  /** Sentence/phrase-level spans with start/end times, ascending. */
  segments: TranscriptSegment[];
};

export type TranscribeOptions = {
  /** Spoken language, or "auto" to detect. Defaults to "auto". */
  language?: WhisperLanguage;
  /** Optional model override; otherwise the active/first downloaded model. */
  model?: WhisperModelId | null;
  signal?: AbortSignal;
};

const WHISPER_SAMPLE_RATE = 16000;

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** Decodes base64 into a view over the underlying signed 16-bit PCM bytes. */
export function decodePcm16Base64(base64: string): Int16Array {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

/**
 * Runs on-device Whisper over mono 16-bit PCM and returns the transcript with
 * segment timings. The PCM comes from the hidden decode host (WebAudio), which
 * already mixed the file to mono; this only resamples to Whisper's 16 kHz input
 * and drives the native `whisper.rn` context.
 *
 * Android/iOS only: the model file must have been downloaded from
 * Settings → Voice input.
 */
export async function transcribePcm16(
  base64: string,
  sampleRate: number,
  options: TranscribeOptions = {},
): Promise<Transcript> {
  if (Platform.OS === "web") {
    throw new Error(
      "On-device transcription is available on Android and iOS only.",
    );
  }
  if (!base64) throw new Error("No decoded audio was provided to transcribe.");
  if (!(sampleRate > 0)) throw new Error("The decoded audio sample rate is invalid.");

  const model = options.model ?? (await resolveTranscriptionModel());
  if (!model) {
    throw new Error(
      "No Whisper model is available. Download one in Settings → Voice input, then try again.",
    );
  }
  if (!isModelDownloaded(model)) {
    throw new Error(
      "The selected Whisper model is missing. Download it in Settings → Voice input.",
    );
  }

  const int16 = decodePcm16Base64(base64);
  if (int16.length === 0) throw new Error("The decoded audio was empty.");
  const floats = new Float32Array(int16.length);
  for (let index = 0; index < int16.length; index += 1) {
    floats[index] = int16[index] / 32768;
  }
  const mono = prepareWhisperAudio([floats], sampleRate, 1);
  if (mono.length === 0) throw new Error("The decoded audio was empty.");
  const pcm = floatToPcm16(mono);

  const whisper = await import("whisper.rn/index").catch(() => null);
  if (!whisper) {
    throw new Error(
      "On-device transcription is not available in this build.",
    );
  }
  const context = await whisper.initWhisper({
    filePath: modelFile(model).uri,
    useGpu: false,
  });

  const language =
    options.language && options.language !== "auto" ? options.language : "auto";
  const task = context.transcribeData(pcm.buffer as ArrayBuffer, {
    language,
    // Greedy decoding hallucinates on short/ambiguous clips; a small beam with
    // best-of is markedly more accurate, matching the voice-input path.
    beamSize: 5,
    bestOf: 5,
    temperature: 0,
    temperatureInc: 0.2,
  });

  const onAbort = () => {
    task.stop().catch(() => {});
  };

  try {
    if (options.signal?.aborted) {
      throw new Error("Transcription was cancelled.");
    }
    options.signal?.addEventListener("abort", onAbort);
    let result: {
      result: string;
      language: string;
      isAborted: boolean;
      segments: { text: string; t0: number; t1: number }[];
    };
    try {
      result = await task.promise;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    if (result.isAborted) throw new Error("Transcription was cancelled.");

    // whisper.cpp reports segment times in centiseconds (10 ms units).
    const segments: TranscriptSegment[] = (result.segments ?? [])
      .map((segment) => ({
        start: round2((segment.t0 ?? 0) / 100),
        end: round2((segment.t1 ?? 0) / 100),
        text: (segment.text ?? "").trim(),
      }))
      .filter((segment) => segment.text.length > 0);

    return {
      text: (result.result ?? "").trim(),
      language: result.language || language,
      duration: round2(mono.length / WHISPER_SAMPLE_RATE),
      segments,
    };
  } finally {
    await context.release();
  }
}
