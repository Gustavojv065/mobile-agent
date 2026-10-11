import { tool } from "ai";
import { z } from "zod";

import { resolveWorkspaceFile } from "@/core/services/workspace-file-service";
import { recognizeImageText } from "@/modules/documents/ocr";
import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";

const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
];

function isImageFile(input: {
  displayName: string;
  mimeType?: string | null;
}) {
  const mimeType = input.mimeType?.toLowerCase() ?? "";

  if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") {
    return true;
  }

  const lowerName = input.displayName.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

export function createOcrTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  return tool({
    description:
      "Recognize text in an image workspace file (png, jpg, jpeg, webp, gif, bmp, heic, heif) using on-device OCR. Scans the image and returns the recognized lines of text. Requires a build with the expo-text-extractor native module. Read-only.",
    inputSchema: z.object({
      fileId: z.string().min(1),
    }),
    execute: async ({ fileId }) => {
      const inputSummary = summarizeValue({ fileId });

      try {
        const file = await repository.getById(fileId);

        if (!file) {
          throw new Error(`No workspace file found for ${fileId}.`);
        }

        if (!isImageFile(file)) {
          throw new Error(
            `${file.displayName} is not an image file; ocr works on image files only.`,
          );
        }

        const localFile = resolveWorkspaceFile(file.relativePath);

        if (!localFile.exists) {
          throw new Error(
            `${file.displayName} is no longer available locally.`,
          );
        }

        const recognition = await recognizeImageText(localFile.uri);
        const output = {
          fileId: file.id,
          displayName: file.displayName,
          available: recognition.available,
          ...(recognition.reason ? { reason: recognition.reason } : {}),
          lineCount: recognition.lines.length,
          text: recognition.text,
        };

        onRecord?.(
          createRecord({
            toolName: "ocr",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue({
              fileId: output.fileId,
              available: output.available,
              lineCount: output.lineCount,
              reason: output.reason ?? null,
              textPreview: output.text.slice(0, 200),
            }),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "ocr",
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