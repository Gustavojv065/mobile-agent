import { tool } from "ai";
import { z } from "zod";

import { createExternalFolderService } from "@/core/services/external-folder/external-folder-service";
import { inferMimeType } from "@/core/services/file-names";
import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { ExternalFolderToolFactoryParams } from "@/modules/tools/built-in/external-folder/types";

/** Keep inline file parts small enough to avoid OOM on-device (~256 MB heap). */
const MAX_FILE_BYTES = 20_000_000;

function resolveMimeType(path: string, mimeType: string | null) {
  if (mimeType?.trim()) {
    return mimeType;
  }

  return inferMimeType(path);
}

function isImageMimeType(mimeType: string) {
  const lower = mimeType.toLowerCase();
  return lower.startsWith("image/") && lower !== "image/svg+xml";
}

type ViewFileOutput = {
  text: string;
  path: string;
  mimeType: string;
  inlineFile: boolean;
  file: Uint8Array | null;
};

/**
 * Passes any external-folder file straight to the model as file input.
 *
 * The folder `read` tool only returns text (`readTextFile`), so asking it to
 * read an image or other binary file either fails or returns garbage — the
 * path alone never becomes usable content. This tool uses `readBytesFile`
 * and returns the bytes inline via `toModelOutput`, letting the model handle
 * the file itself.
 */
export function createExternalViewFileTool({
  onRecord,
  session,
  supportsImageInput = true,
}: ExternalFolderToolFactoryParams) {
  const service = createExternalFolderService();

  return tool({
    description:
      "Look at any file inside the granted external folder by passing its path from listDirectory. Returns the file bytes inline so you can use its contents directly — images, PDFs, audio, or any other file. Use this to describe, compare, or read all files. Do not use read for images or other binary files (text only). On models without image input, images only return the path: ask the user what they see.",
    inputSchema: z.object({
      path: z.string().trim().min(1),
    }),
    execute: async ({ path }: { path: string }) => {
      const inputSummary = summarizeValue({ path });

      try {
        const { bytes, mimeType } = await service.readBytesFile(session, path);

        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error(
            `"${path}" is too large to view inline (${bytes.byteLength} bytes, max ${MAX_FILE_BYTES}).`,
          );
        }

        const resolvedMimeType = resolveMimeType(path, mimeType);
        const text =
          `File "${path}" (${resolvedMimeType}). Use its contents when replying.`;
        const imageWithoutVision =
          isImageMimeType(resolvedMimeType) && !supportsImageInput;

        const output: ViewFileOutput = {
          text: imageWithoutVision
            ? `${text} Your model cannot display images, so ask the user what they see.`
            : text,
          path,
          mimeType: resolvedMimeType,
          inlineFile: !imageWithoutVision,
          file: imageWithoutVision ? null : bytes,
        };

        onRecord?.(
          createRecord({
            toolName: "viewFile",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue({
              path: output.path,
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
