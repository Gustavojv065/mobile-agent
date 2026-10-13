import { tool } from "ai";
import { z } from "zod";

import { inferMimeType } from "@/core/services/file-names";
import { resolveWorkspaceFile } from "@/core/services/workspace-file-service";
import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";

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

function isImageMimeType(mimeType: string) {
  const lower = mimeType.toLowerCase();
  return lower.startsWith("image/") && lower !== "image/svg+xml";
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
 * Passes any workspace file straight to the model as file input.
 *
 * `read` handles text/docs only and `ocr` returns text lines only, so without
 * this the model can list a file (via `listFiles`) but never see non-text
 * bytes — it then guesses or asks the user to show it on screen. This tool
 * reads the bytes and returns them inline via `toModelOutput`, letting the
 * model handle images, PDFs, audio, or any other file itself.
 */
export function createViewFileTool({
  onRecord,
  repository,
  supportsImageInput = true,
}: WorkspaceToolFactoryParams) {
  return tool({
    description:
      "Look at any workspace file by passing its fileId from listFiles. Returns the file bytes inline so you can use its contents directly — images, PDFs, audio, or any other file. Use this to describe, compare, or read all files. Do not use read for images or other binary files (text/docs only) and do not use ocr when the user wants the actual file content. On models without image input, images only return the file link: use ocr for on-screen text or ask the user what they see.",
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

        const bytes = await localFile.bytes();

        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error(
            `${file.displayName} is too large to view inline (${bytes.byteLength} bytes, max ${MAX_FILE_BYTES}).`,
          );
        }

        const mimeType = resolveMimeType(file);
        const text =
          `File "${file.displayName}" (workspace://${file.id}, ${mimeType}). ` +
          "Use its contents when replying.";
        const imageWithoutVision =
          isImageMimeType(mimeType) && !supportsImageInput;

        const output: ViewFileOutput = {
          text: imageWithoutVision
            ? `${text} Your model cannot display images, so inspect it with the ocr tool for on-screen text, or ask the user what they see.`
            : text,
          fileId: file.id,
          displayName: file.displayName,
          mimeType,
          inlineFile: !imageWithoutVision,
          file: imageWithoutVision ? null : bytes,
        };

        onRecord?.(
          createRecord({
            toolName: "viewFile",
            status: "completed",
            inputSummary,
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
