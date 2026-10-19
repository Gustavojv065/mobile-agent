import { tool } from "ai";
import { z } from "zod";

import { createExternalFolderService } from "@/core/services/external-folder/external-folder-service";
import { inferMimeType } from "@/core/services/file-names";
import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { ExternalFolderToolFactoryParams } from "@/modules/tools/built-in/external-folder/types";
import { fileInputGuidance } from "@/modules/tools/built-in/file-input-guidance";

/** Keep inline file parts small enough to avoid OOM on-device (~256 MB heap). */
const MAX_FILE_BYTES = 20_000_000;

function resolveMimeType(path: string, mimeType: string | null) {
  if (mimeType?.trim()) {
    return mimeType;
  }

  return inferMimeType(path);
}

type ViewFileOutput = {
  text: string;
  path: string;
  mimeType: string;
  inlineFile: boolean;
  file: Uint8Array | null;
};

/**
 * Passes external-folder files subject to the model's input modalities.
 *
 * The folder `read` tool only returns text (`readTextFile`), so asking it to
 * read an image or other binary file either fails or returns garbage — the
 * path alone never becomes usable content. This tool uses `readBytesFile`
 * and returns the bytes inline via `toModelOutput`, letting the model handle
 * supported files itself; unsupported media gets workspace-import guidance.
 */
export function createExternalViewFileTool({
  onRecord,
  session,
  supportsImageInput = true,
  supportsAudioInput = false,
  supportsVideoInput = false,
}: ExternalFolderToolFactoryParams) {
  const service = createExternalFolderService();

  return tool({
    description:
      "Look at a file inside the granted external folder using its path from listDirectory. Inline media is limited to modalities supported by the active model. For unsupported audio/video, first importFolderFileToWorkspace, then use getVideoFrame, transcribeAudio or analyzeAudio with the returned fileId. Do not retry viewFile to bypass modality restrictions. Use read for text files.",
    inputSchema: z.object({
      path: z.string().trim().min(1),
    }),
    execute: async ({ path }: { path: string }) => {
      const inputSummary = summarizeValue({ path });

      try {
        const capabilities = { supportsImageInput, supportsAudioInput, supportsVideoInput };
        const inferredMime = resolveMimeType(path, null);
        // Avoid allocating the entire clip when its extension already tells
        // us this model cannot use it. Still check the actual MIME if read.
        const inferredGuidance = fileInputGuidance(inferredMime, capabilities, true);
        const loaded = inferredGuidance ? null : await service.readBytesFile(session, path);
        const resolvedMimeType = loaded ? resolveMimeType(path, loaded.mimeType) : inferredMime;
        const guidance = inferredGuidance ?? fileInputGuidance(resolvedMimeType, capabilities, true);
        const bytes = guidance ? null : loaded!.bytes;

        if (bytes && bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error(
            `"${path}" is too large to view inline (${bytes.byteLength} bytes, max ${MAX_FILE_BYTES}).`,
          );
        }

        const text =
          `File "${path}" (${resolvedMimeType}). Use its contents when replying.`;

        const output: ViewFileOutput = {
          text: guidance
            ? `File "${path}" (${resolvedMimeType}). ${guidance}`
            : text,
          path,
          mimeType: resolvedMimeType,
          inlineFile: !guidance,
          file: bytes,
        };

        onRecord?.(
          createRecord({
            toolName: "viewFile",
            status: "completed",
            inputSummary,
            preview: { title: path, uri: loaded?.uri, mimeType: resolvedMimeType, text: guidance ?? undefined },
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
