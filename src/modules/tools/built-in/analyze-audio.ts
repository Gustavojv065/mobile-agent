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

/**
 * Analyzes an audio file already in the workspace and returns a compact,
 * deterministic feature summary (duration, tempo, onset times, energy/band
 * curves) so the agent can author visuals that follow the actual soundtrack.
 *
 * The decode + analysis happens in the hidden WebView host using the same
 * engine the recorder uses, so the numbers match the live `audio` object a page
 * sees at render time.
 */
export function createAnalyzeAudioTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  return tool({
    description:
      "Analyze an audio file already saved in the workspace and get its musical/structural features before authoring a video or animation that should follow it. Returns duration, an estimated bpm (or null), detected onset times in seconds (`beats`), and downsampled energy/band curves (0..1) you can use to place cuts, text, or beats. Use this when the user gives you an audio file and asks for visuals 'as per the audio', so you are not guessing the rhythm. The same features are also available live inside a video render as the fourth `render` argument (`audio`), so you can either hard-code the timings here or react in-scene. Decoding happens on device; MP3, WAV, M4A, AAC, OGG, and WebM files up to 15 MB are supported.",
    inputSchema: z.object({
      fileId: z
        .string()
        .min(1)
        .describe(
          "The id of a workspace audio file to analyze (MP3, WAV, M4A, AAC, OGG, or WebM).",
        ),
      maxSeconds: z
        .number()
        .min(1)
        .max(180)
        .optional()
        .describe(
          "Only analyze the first N seconds (default 90). Use a larger value for long tracks.",
        ),
    }),
    execute: async ({ fileId, maxSeconds }, { abortSignal }) => {
      const inputSummary = summarizeValue({
        fileId,
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

        const { summary } = await requestAudioAnalysis({
          src: buildAudioDataUri(mimeType, bytes),
          maxSeconds: maxSeconds ?? 90,
          sampleRate: 22050,
          signal: abortSignal,
        });

        const output = {
          fileId: record.id,
          displayName: record.displayName,
          ...summary,
        };

        onRecord?.(
          createRecord({
            toolName: "analyzeAudio",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue(output),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "analyzeAudio",
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
