import { File } from "expo-file-system";
import { tool } from "ai";
import { getThumbnailAsync } from "expo-video-thumbnails";
import { z } from "zod";

import { createWorkspaceFileService, resolveWorkspaceFile } from "@/core/services/workspace-file-service";
import {
  createRecord,
  summarizeValue,
} from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";

/**
 * Extracts a still frame from a workspace video so the agent can *see* a
 * timestamp ("at 0:12 the logo clips") instead of guessing from the script.
 *
 * Vision-capable models receive the frame inline as an image part plus the
 * saved workspace file. Models without image input get the saved file link
 * and are directed to the `ocr` tool for on-screen text. Either way the frame
 * is persisted, so follow-up turns can reference it by fileId.
 */

/**
 * execute's return value. `image` bytes travel here (in memory only) so
 * `toModelOutput` can build a real vision content part. They are never sent
 * to the model as raw JSON — see below.
 */
type VideoFrameOutput = {
  text: string;
  fileId: string;
  link: string;
  time: number;
  width: number;
  height: number;
  inlineImage: boolean;
  image: Uint8Array | null;
};

export function createVideoFrameTool({
  onRecord,
  repository,
  supportsImageInput = true,
}: WorkspaceToolFactoryParams) {
  const workspaceService = createWorkspaceFileService(repository);
  return tool({
    description:
      "Grab a still frame from a workspace video at a given timestamp and look at it. Use this when the user points at a moment in a rendered video ('at 0:12 the logo is cut off', 'check the middle'). Pass the video fileId and time in seconds. Returns the frame as a workspace image file and — on vision-capable models — inline image content you can actually see. On models without image input you only get the file link: use the ocr tool to read on-screen text, or ask the user what they see.",
    inputSchema: z.object({
      fileId: z
        .string()
        .min(1)
        .describe("The id of a workspace video file (e.g. from renderVideo)."),
      time: z
        .number()
        .min(0)
        .max(3600)
        .describe(
          "Timestamp in seconds into the video (e.g. 12 for 'at 0:12').",
        ),
    }),
    execute: async ({ fileId, time }: { fileId: string; time: number }) => {
      const inputSummary = summarizeValue({ fileId, time });

      try {
        const record = await repository.getById(fileId);
        if (!record) {
          throw new Error(`No workspace file found with id ${fileId}.`);
        }
        const source = resolveWorkspaceFile(record.relativePath);
        if (!source.exists) {
          throw new Error(
            `"${record.displayName}" is no longer available locally.`,
          );
        }

        const thumb = await getThumbnailAsync(source.uri, {
          time: Math.round(time * 1000),
          quality: 0.9,
        });
        const thumbFile = new File(thumb.uri);
        const bytes = await thumbFile.bytes();
        try {
          thumbFile.delete();
        } catch {
          // Cache cleanup is best-effort.
        }

        const baseName = record.displayName.replace(/\.[a-z0-9]+$/i, "");
        const saved = await workspaceService.createDocumentFile({
          bytes,
          mimeType: "image/jpeg",
          name: `${baseName}-frame-${time}s.jpg`,
        });

        const text =
          `Frame at ${time}s of "${record.displayName}" ` +
          `(${thumb.width}x${thumb.height}), saved as workspace://${saved.id}. ` +
          "Describe what you see at this timestamp when replying.";

        // NOTE: execute's return value is only passed to `toModelOutput`
        // below — it is never sent to the model as-is. Without toModelOutput
        // the SDK would serialize this object (including `image` bytes) as a
        // giant JSON blob, which stalls the run. toModelOutput converts it to
        // a real vision content part instead.
        const output = {
          text: supportsImageInput
            ? text
            : `${text} Your model cannot display images, so inspect the ` +
              `saved frame with the ocr tool for on-screen text, or ask ` +
              `the user what they see at this timestamp.`,
          fileId: saved.id,
          link: `workspace://${saved.id}`,
          time,
          width: thumb.width,
          height: thumb.height,
          inlineImage: supportsImageInput,
          image: supportsImageInput ? bytes : null,
        };

        onRecord?.(
          createRecord({
            toolName: "getVideoFrame",
            status: "completed",
            inputSummary,
            preview: { title: `${record.displayName} · ${time}s`, uri: resolveWorkspaceFile(saved.relativePath).uri, mimeType: "image/jpeg" },
            outputSummary: summarizeValue({
              fileId: saved.id,
              link: `workspace://${saved.id}`,
              time,
              width: thumb.width,
              height: thumb.height,
              inlineImage: supportsImageInput,
            }),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "getVideoFrame",
            status: "failed",
            inputSummary,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        throw error;
      }
    },
    toModelOutput: ({ output }: { output: VideoFrameOutput }) => {
      if (output.image) {
        return {
          type: "content",
          value: [
            { type: "text", text: output.text },
            {
              type: "file",
              data: { type: "data", data: output.image },
              mediaType: "image/jpeg",
            },
          ],
        };
      }
      return { type: "text", value: output.text };
    },
  });
}
