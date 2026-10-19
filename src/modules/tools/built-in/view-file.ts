import { tool } from "ai";
import { z } from "zod";

import { inferMimeType } from "@/core/services/file-names";
import { resolveWorkspaceFile } from "@/core/services/workspace-file-service";
import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { fileInputGuidance } from "@/modules/tools/built-in/file-input-guidance";

/** Keep inline file parts small enough to avoid OOM on-device (~256 MB heap). */
const MAX_FILE_BYTES = 20_000_000;

function resolveMimeType(file: {
  displayName: string;
  mimeType?: string | null;
}) {
  if (file.mimeType?.trim()) {
    return file.mimeType;
  }

  return inferMimeType(file.displayName);
}

type ViewFileOutput = {
  text: string;
  fileId: string;
  displayName: string;
  mimeType: string;
  inlineFile: boolean;
  file: Uint8Array | null;
};

/**
 * Passes workspace files to the model subject to its input modalities.
 *
 * `read` handles text/docs only and `ocr` returns text lines only, so without
 * this the model can list a file (via `listFiles`) but never see non-text
 * bytes — it then guesses or asks the user to show it on screen. This tool
 * reads the bytes and returns them inline via `toModelOutput`, letting the
 * model handle supported files itself. Unsupported media stays link-only
 * with tool guidance and is never read into memory here.
 */
export function createViewFileTool({
  onRecord,
  repository,
  supportsImageInput = true,
  supportsAudioInput = false,
  supportsVideoInput = false,
}: WorkspaceToolFactoryParams) {
  return tool({
    description:
      "Look at a workspace file by passing its fileId from listFiles. Returns inline bytes only for media modalities supported by the active model. Unsupported audio/video returns tool guidance instead: getVideoFrame for visuals, transcribeAudio for speech, analyzeAudio for soundtrack features. Do not retry viewFile to bypass a modality restriction. Use read for text/docs and ocr for images on models without image input.",
    inputSchema: z.object({
      fileId: z.string().min(1),
    }),
    execute: async ({ fileId }: { fileId: string }) => {
      const inputSummary = summarizeValue({ fileId });

      try {
        const file = await repository.getById(fileId);

        if (!file) {
          throw new Error(`No workspace file found for ${fileId}.`);
        }

        const localFile = resolveWorkspaceFile(file.relativePath);

        if (!localFile.exists) {
          throw new Error(
            `${file.displayName} is no longer available locally.`,
          );
        }

        const mimeType = resolveMimeType(file);
        const guidance = fileInputGuidance(mimeType, { supportsImageInput, supportsAudioInput, supportsVideoInput });
        if (!guidance && localFile.size > MAX_FILE_BYTES) {
          throw new Error(`${file.displayName} is too large to view inline (${localFile.size} bytes, max ${MAX_FILE_BYTES}).`);
        }
        const bytes = guidance ? null : await localFile.bytes();

        if (bytes && bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error(
            `${file.displayName} is too large to view inline (${bytes.byteLength} bytes, max ${MAX_FILE_BYTES}).`,
          );
        }

        const text =
          `File "${file.displayName}" (workspace://${file.id}, ${mimeType}). ` +
          "Use its contents when replying.";

        const output: ViewFileOutput = {
          text: guidance
            ? `File "${file.displayName}" (workspace://${file.id}, ${mimeType}). ${guidance}`
            : text,
          fileId: file.id,
          displayName: file.displayName,
          mimeType,
          inlineFile: !guidance,
          file: bytes,
        };

        onRecord?.(
          createRecord({
            toolName: "viewFile",
            status: "completed",
            inputSummary,
            preview: { title: file.displayName, uri: localFile.uri, mimeType, text: guidance ?? undefined },
            outputSummary: summarizeValue({
              fileId: output.fileId,
              displayName: output.displayName,
              inlineFile: output.inlineFile,
            }),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "viewFile",
            status: "failed",
            inputSummary,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        throw error;
      }
    },
    toModelOutput: ({ output }: { output: ViewFileOutput }) => {
      if (output.file) {
        return {
          type: "content",
          value: [
            { type: "text", text: output.text },
            {
              type: "file",
              data: { type: "data", data: output.file },
              mediaType: output.mimeType,
            },
          ],
        };
      }
      return { type: "text", value: output.text };
    },
  });
}
