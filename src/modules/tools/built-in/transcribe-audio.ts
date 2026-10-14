import { tool } from "ai";
import { z } from "zod";

import { resolveWorkspaceFile } from "@/core/services/workspace-file-service";
import {
  assertAudioFileUsable,
  buildAudioDataUri,
} from "@/modules/preview/video-audio";
import { requestAudioAnalysis } from "@/modules/preview/video-audio-analysis-job";
import {
  createRecord,
  summarizeValue,
} from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { transcribePcm16 } from "@/modules/voice/transcribe";
import { transcribePcm16WithSystem } from "@/modules/voice/system-transcribe";
import type { WhisperLanguage } from "@/modules/voice/models";

/**
 * Transcribes an audio file already in the workspace and returns timed text, so
 * the agent can author visuals that react to (or caption) actual spoken words.
 *
 * Decoding happens in the hidden WebView host (WebAudio), which hands back mono
 * 16 kHz PCM. The engine that turns that PCM into words is selectable:
 *
 *  - `whisper` (default): the bundled on-device Whisper models, available
 *    everywhere a model is downloaded and reliable about timings.
 *  - `system`: the device's own recognizer, which is a different model and
 *    occasionally more accurate; see system-transcribe.ts for its limits.
 *
 * The timings are deterministic and can be baked into the HTML, or mirrored at
 * render time (see the speech track exposed to the recorder).
 */
export function createTranscribeAudioTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  return tool({
    description:
      'Transcribe speech in an audio file already saved in the workspace and get the words with start/end times in seconds. Use this when the user wants a video, animation, or captions that follow what is said in a recording (e.g. \'make the words pop up as they are spoken\'). Returns the full `text`, a detected `language`, the audio `duration`, and `segments` (sentence/phrase-level spans with `start`, `end`, and `text`). Runs entirely on device with the Whisper model downloaded in Settings → Voice input; MP3, WAV, M4A, AAC, OGG, and WebM files up to 15 MB are supported. Pass engine: "system" to use the device\'s own speech recognizer instead of Whisper (Android 13+; it reports word timings and therefore `segments` only on Android 14+ with the on-device speech model, otherwise it returns text with no timings). This only transcribes speech - it does not analyze music, so use analyzeAudio for tempo, melody, notes, and key.',
    inputSchema: z.object({
      fileId: z
        .string()
        .min(1)
        .describe(
          "The id of a workspace audio file to transcribe (MP3, WAV, M4A, AAC, OGG, or WebM).",
        ),
      language: z
        .string()
        .min(2)
        .max(8)
        .optional()
        .describe(
          "Spoken language code such as 'en', 'es', or 'de'. Omit to auto-detect.",
        ),
      maxSeconds: z
        .number()
        .min(1)
        .max(180)
        .optional()
        .describe(
          "Only transcribe the first N seconds (default 90). Use a larger value for long recordings.",
        ),
      engine: z
        .enum(["whisper", "system"])
        .optional()
        .describe(
          'Which recognizer to use. "whisper" (default) uses the downloaded on-device models and always returns timed segments. "system" uses the device\'s own recognizer (Android 13+), which is sometimes more accurate but only returns timed segments on Android 14+ with the on-device speech model.',
        ),
    }),
    execute: async ({ fileId, language, maxSeconds, engine }, { abortSignal }) => {
      const inputSummary = summarizeValue({
        fileId,
        language: language ?? null,
        maxSeconds: maxSeconds ?? null,
        engine: engine ?? "whisper",
      });

      try {
        const record = await repository.getById(fileId);
        if (!record) {
          throw new Error(`No workspace file found with id ${fileId}.`);
        }

        const file = resolveWorkspaceFile(record.relativePath);
        if (!file.exists) {
          throw new Error(
            `Audio file "${record.displayName}" is no longer available locally.`,
          );
        }

        const bytes = await file.bytes();
        const mimeType = assertAudioFileUsable(
          record.displayName,
          record.mimeType,
          bytes.length,
        );

        const { pcm } = await requestAudioAnalysis({
          src: buildAudioDataUri(mimeType, bytes),
          maxSeconds: maxSeconds ?? 90,
          sampleRate: 16000,
          pcmSampleRate: 16000,
          signal: abortSignal,
        });
        if (!pcm) {
          throw new Error(
            "This build cannot decode audio for transcription.",
          );
        }

        const useSystem = engine === "system";
        const transcript = useSystem
          ? await transcribePcm16WithSystem(pcm.base64, pcm.sampleRate, {
              language,
              signal: abortSignal,
            })
          : await transcribePcm16(pcm.base64, pcm.sampleRate, {
              language: (language as WhisperLanguage | undefined) ?? "auto",
              signal: abortSignal,
            });

        const output: Record<string, unknown> = {
          fileId: record.id,
          displayName: record.displayName,
          engine: useSystem ? "system" : "whisper",
          language: transcript.language,
          duration: transcript.duration,
          text: transcript.text,
          segmentCount: transcript.segments.length,
          segments: transcript.segments,
        };
        if (useSystem && transcript.segments.length === 0) {
          output.warning =
            'The system recognizer did not report word timings on this device, so there are no timed `segments` (captions cannot be placed from this result). Re-run with engine "whisper" if you need timings.';
        }

        onRecord?.(
          createRecord({
            toolName: "transcribeAudio",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue(output),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "transcribeAudio",
            status: "failed",
            inputSummary,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        throw error;
      }
    },
  });
}
