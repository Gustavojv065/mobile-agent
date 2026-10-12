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
import type { WhisperLanguage } from "@/modules/voice/models";

/**
 * Transcribes an audio file already in the workspace with on-device Whisper and
 * returns timed text, so the agent can author visuals that react to (or caption)
 * actual spoken words.
 *
 * Decoding happens in the hidden WebView host (WebAudio), which hands back mono
 * 16 kHz PCM; the native `whisper.rn` context then produces the transcript. The
 * timings are deterministic and can be baked into the HTML, or mirrored at
 * render time (see the speech track exposed to the recorder).
 */
export function createTranscribeAudioTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  return tool({
    description:
      "Transcribe speech in an audio file already saved in the workspace and get the words with start/end times in seconds. Use this when the user wants a video, animation, or captions that follow what is said in a recording (e.g. 'make the words pop up as they are spoken'). Returns the full `text`, a detected `language`, the audio `duration`, and `segments` (sentence/phrase-level spans with `start`, `end`, and `text`). Runs entirely on device with the Whisper model downloaded in Settings → Voice input; MP3, WAV, M4A, AAC, OGG, and WebM files up to 15 MB are supported. This only transcribes speech - it does not analyze music, so use analyzeAudio for rhythm.",
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
    }),
    execute: async ({ fileId, language, maxSeconds }, { abortSignal }) => {
      const inputSummary = summarizeValue({
        fileId,
        language: language ?? null,
        maxSeconds: maxSeconds ?? null,
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

        const transcript = await transcribePcm16(pcm.base64, pcm.sampleRate, {
          language: (language as WhisperLanguage | undefined) ?? "auto",
          signal: abortSignal,
        });

        const output = {
          fileId: record.id,
          displayName: record.displayName,
          language: transcript.language,
          duration: transcript.duration,
          text: transcript.text,
          segmentCount: transcript.segments.length,
          segments: transcript.segments,
        };

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
