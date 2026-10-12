import { Directory, File, Paths } from "expo-file-system";
import {
  AudioEncodingAndroid,
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionResultSegment,
} from "expo-speech-recognition";
import { Platform } from "react-native";

import { decodePcm16Base64, type Transcript, type TranscriptSegment } from "./transcribe";
import { encodeWavPcm16 } from "./wav";

/**
 * Transcribes an audio file with the **system** speech recognizer instead of the
 * bundled Whisper models.
 *
 * `transcribeAudio` normally runs Whisper on-device, which is deterministic and
 * available everywhere the model is downloaded. The device's own recognizer is a
 * different model with different failure modes — sometimes noticeably better on
 * proper nouns and accents — so it is offered as an opt-in engine.
 *
 * Mechanically: the hidden decode host hands back mono 16 kHz PCM (the same
 * input Whisper gets), which is wrapped in a WAV container and streamed to
 * `expo-speech-recognition` via `audioSource.uri`. That reuses the library's
 * Android 13+ file transcription (`RecognizerIntent.EXTRA_AUDIO_SOURCE`) with no
 * extra native code, and keeps `maxSeconds` meaningful because the audio is
 * already trimmed before the recognizer sees it.
 *
 * Word-level timings come from Android's `EXTRA_REQUEST_WORD_TIMING` and are
 * only reported on Android 14+ with the on-device `com.google.android.as`
 * service; otherwise the recognizer returns text with no timing, so the caller
 * gets `segments: []` and must fall back to Whisper for captions.
 */

/** Android 13: `EXTRA_AUDIO_SOURCE`, i.e. file input. */
export const SYSTEM_FILE_MIN_API = 33;
/** Android 14: `EXTRA_REQUEST_WORD_TIMING`, i.e. word-level timings. */
export const SYSTEM_WORD_TIMING_MIN_API = 34;

/** One recognized word (or short run of words) with its time on the audio. */
export type SpeechWord = TranscriptSegment;

/** A sentence/phrase-level span, merged from word timings for captions. */
export type SpeechPhrase = TranscriptSegment;

export type SystemTranscript = Transcript & {
  /** True when the recognizer reported word timings we could group. */
  hasWordTimings: boolean;
  /** True when the on-device recognizer produced the transcript. */
  onDevice: boolean;
};

export type SystemTranscribeOptions = {
  /** Spoken language code such as "en" or "en-US"; omit for the device default. */
  language?: string;
  /**
   * Prefer the on-device recognizer. Needed for word timings, but unavailable on
   * some devices; the caller falls back to network recognition automatically.
   * Default true.
   */
  preferOnDevice?: boolean;
  signal?: AbortSignal;
  /** Wall-clock limit for the recognizer. Default 120 s. */
  timeoutMs?: number;
};

export type SystemSupport = {
  /** Whether this device can transcribe a file with the system recognizer. */
  supported: boolean;
  /** Whether word timings (and therefore captions) can be expected. */
  wordTimings: boolean;
  /** Human-readable reason when `supported` is false. */
  reason?: string;
};

const DEFAULT_TIMEOUT_MS = 120_000;

const ERROR_MESSAGES: Record<string, string> = {
  "audio-capture":
    'This device cannot transcribe an audio file with the system recognizer (it needs Android 13+). Use engine "whisper" instead.',
  aborted: "Transcription was cancelled.",
  busy: "The system speech recognizer is busy. Try again in a moment.",
  "language-not-supported":
    'The system recognizer does not support that language. Use engine "whisper" instead.',
  network:
    'Network-based system recognition failed. Install the on-device speech model, or use engine "whisper".',
  "no-speech":
    "The system recognizer did not detect any speech in the audio file.",
  "not-allowed":
    'System transcription needs microphone permission. Grant it for this app, or use engine "whisper".',
  "service-not-allowed":
    'No system speech recognition service is available on this device. Use engine "whisper" instead.',
};

function androidApiLevel(): number {
  const version = Number(Platform.Version);
  return Number.isFinite(version) ? Math.floor(version) : 0;
}

/**
 * Whether the system engine can run here, and whether it will report word
 * timings. Callers use this to explain a refusal instead of failing vaguely.
 */
export function systemTranscriptionSupport(): SystemSupport {
  if (Platform.OS !== "android") {
    return {
      supported: false,
      wordTimings: false,
      reason:
        'The system engine currently transcribes files on Android only. Use engine "whisper".',
    };
  }
  const api = androidApiLevel();
  if (api < SYSTEM_FILE_MIN_API) {
    return {
      supported: false,
      wordTimings: false,
      reason: `Transcribing a file with the system recognizer needs Android 13 (API ${SYSTEM_FILE_MIN_API}); this device is API ${api}. Use engine "whisper".`,
    };
  }
  return { supported: true, wordTimings: api >= SYSTEM_WORD_TIMING_MIN_API };
}

function describeError(event: ExpoSpeechRecognitionErrorEvent): string {
  const mapped = ERROR_MESSAGES[event?.error ?? ""];
  if (mapped) return mapped;
  const message = (event?.message ?? "").trim();
  return message
    ? `System speech recognition failed: ${message}`
    : `System speech recognition failed (${event?.error ?? "unknown"}).`;
}

/** Maps the native word segments to seconds, dropping blanks and sorting. */
export function normalizeSpeechWords(
  segments: ExpoSpeechRecognitionResultSegment[] | undefined,
): SpeechWord[] {
  if (!Array.isArray(segments)) return [];
  const words: SpeechWord[] = [];
  for (const segment of segments) {
    const text = typeof segment?.segment === "string" ? segment.segment.trim() : "";
    if (!text) continue;
    const start = Math.max(0, (Number(segment.startTimeMillis) || 0) / 1000);
    const end = Math.max(start, (Number(segment.endTimeMillis) || 0) / 1000);
    words.push({ start, end, text });
  }
  words.sort((a, b) => a.start - b.start || a.end - b.end);
  return words;
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

/**
 * Groups word timings into the sentence/phrase spans the speech track (and the
 * `transcribeAudio` output) expects, so the system engine returns the same shape
 * as Whisper. A span is closed by a sentence-ending word, a pause longer than
 * `maxGapSeconds`, or a length/word limit.
 */
export function mergeWordSegments(
  words: SpeechWord[],
  options: { maxChars?: number; maxGapSeconds?: number; maxWords?: number } = {},
): SpeechPhrase[] {
  const maxChars = options.maxChars ?? 42;
  const maxGapSeconds = options.maxGapSeconds ?? 0.8;
  const maxWords = options.maxWords ?? 12;

  const phrases: SpeechPhrase[] = [];
  let parts: string[] = [];
  let start = 0;
  let end = 0;

  const flush = () => {
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) phrases.push({ start, end, text });
    parts = [];
  };

  for (const word of words) {
    const text = word.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const wordStart = Math.max(0, word.start);
    const wordEnd = Math.max(wordStart, word.end);

    if (parts.length > 0) {
      const gap = wordStart - end;
      const overflow =
        `${parts.join(" ")} ${text}`.length > maxChars ||
        parts.length + 1 > maxWords;
      if (gap > maxGapSeconds || overflow || SENTENCE_END.test(parts[parts.length - 1])) {
        flush();
      }
    }

    if (parts.length === 0) {
      start = wordStart;
      end = wordEnd;
    } else if (wordEnd > end) {
      end = wordEnd;
    }
    parts.push(text);
  }

  flush();
  return phrases;
}

type RecognitionOutcome = {
  text: string;
  words: SpeechWord[];
};

function runRecognition(
  uri: string,
  options: {
    language?: string;
    onDevice: boolean;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<RecognitionOutcome> {
  const module = ExpoSpeechRecognitionModule;
  return new Promise<RecognitionOutcome>((resolve, reject) => {
    let settled = false;
    const subscriptions: { remove: () => void }[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onAbort = () => {
      finish(() => reject(new Error("Transcription was cancelled.")));
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const subscription of subscriptions) {
        try {
          subscription.remove();
        } catch {
          // The native emitter is gone; nothing left to detach.
        }
      }
      subscriptions.length = 0;
      options.signal?.removeEventListener("abort", onAbort);
      try {
        module.abort();
      } catch {
        // Already stopped.
      }
    };

    function finish(settle: () => void) {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    }

    const fail = (message: string) => finish(() => reject(new Error(message)));

    subscriptions.push(
      module.addListener("result", (event) => {
        if (!event?.isFinal) return;
        const first = event.results?.[0];
        finish(() =>
          resolve({
            text: (first?.transcript ?? "").trim(),
            words: normalizeSpeechWords(first?.segments),
          }),
        );
      }),
      module.addListener("error", (event) => {
        fail(describeError(event));
      }),
      module.addListener("end", () => {
        fail(
          "The system speech recognizer stopped before returning a transcript.",
        );
      }),
    );

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort);
    timer = setTimeout(
      () => fail("The system speech recognizer timed out."),
      options.timeoutMs,
    );

    try {
      module.start({
        ...(options.language ? { lang: options.language } : {}),
        interimResults: false,
        continuous: false,
        maxAlternatives: 1,
        requiresOnDeviceRecognition: options.onDevice,
        audioSource: {
          uri,
          audioChannels: 1,
          audioEncoding: AudioEncodingAndroid.ENCODING_PCM_16BIT,
          sampleRate: 16000,
        },
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });
}

let scratchCounter = 0;

function writeScratchWav(bytes: Uint8Array): File {
  const directory = new Directory(Paths.cache, "mobile-agent-speech");
  try {
    directory.create({ intermediates: true, idempotent: true });
  } catch {
    // Already present.
  }
  scratchCounter += 1;
  const file = new File(directory, `speech-${Date.now()}-${scratchCounter}.wav`);
  if (file.exists) file.delete();
  file.write(bytes);
  return file;
}

/**
 * Runs the system speech recognizer over mono 16-bit PCM and returns the
 * transcript in the same shape as {@link transcribePcm16}.
 *
 * Throws with an actionable message when the device cannot do it (see
 * {@link systemTranscriptionSupport}); callers should surface that verbatim and
 * suggest the Whisper engine.
 */
export async function transcribePcm16WithSystem(
  base64: string,
  sampleRate: number,
  options: SystemTranscribeOptions = {},
): Promise<SystemTranscript> {
  const support = systemTranscriptionSupport();
  if (!support.supported) {
    throw new Error(support.reason ?? "System transcription is unavailable.");
  }
  if (!base64) throw new Error("No decoded audio was provided to transcribe.");
  if (!(sampleRate > 0)) {
    throw new Error("The decoded audio sample rate is invalid.");
  }

  const samples = decodePcm16Base64(base64);
  if (samples.length === 0) throw new Error("The decoded audio was empty.");

  if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
    throw new Error(
      'No system speech recognition service is available on this device. Use engine "whisper" instead.',
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const file = writeScratchWav(encodeWavPcm16(samples, sampleRate));
  const seconds = samples.length / sampleRate;

  try {
    // On-device recognition is what reports word timings, but it is missing on
    // many devices, so fall back to the network recognizer (text only).
    const attempts =
      support.wordTimings && (options.preferOnDevice ?? true) ? [true, false] : [false];
    let outcome: RecognitionOutcome | null = null;
    let usedOnDevice = false;
    let lastError: unknown = null;

    for (const onDevice of attempts) {
      try {
        outcome = await runRecognition(file.uri, {
          language: options.language,
          onDevice,
          signal: options.signal,
          timeoutMs,
        });
        usedOnDevice = onDevice;
        break;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        lastError = error;
      }
    }

    if (!outcome) {
      throw lastError instanceof Error
        ? lastError
        : new Error("The system speech recognizer returned no result.");
    }

    const hasWordTimings = outcome.words.length > 0;
    const segments = hasWordTimings ? mergeWordSegments(outcome.words) : [];
    const duration =
      segments.length > 0
        ? segments[segments.length - 1].end
        : Math.round(seconds * 100) / 100;

    return {
      text: outcome.text || segments.map((segment) => segment.text).join(" "),
      language: options.language ?? "unknown",
      duration,
      segments,
      hasWordTimings,
      onDevice: usedOnDevice,
    };
  } finally {
    try {
      if (file.exists) file.delete();
    } catch {
      // Scrub best-effort; the cache directory is reclaimed by the OS anyway.
    }
  }
}
